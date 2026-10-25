-- Persist only sanitized signed OIDC claims. Tokens and the former REST account
-- probe are not execution authority and are never stored here.
alter table unfurl.code_execution_runs
  add column capability_evidence jsonb check (
    capability_evidence is null or (
      jsonb_typeof(capability_evidence)='object'
      and capability_evidence ?& array['source','teamId','projectId','environment','issuer','subject','issuedAt',
        'expiresAt','plan','runtimeProfile','image','imageDigest','runnerDigest','runtimeDigest']
      and capability_evidence - array['source','teamId','projectId','environment','issuer','subject','issuedAt',
        'expiresAt','plan','runtimeProfile','image','imageDigest','runnerDigest','runtimeDigest']='{}'::jsonb
      and capability_evidence->>'source'='vercel_oidc_signed_claim_v1'
      and capability_evidence->>'plan'='hobby'
      and capability_evidence->>'environment' in ('production','preview','development')
      and length(capability_evidence->>'teamId') between 1 and 128
      and (capability_evidence->>'projectId') ~ '^prj_[A-Za-z0-9]+$'
      and length(capability_evidence->>'issuer') between 1 and 512
      and length(capability_evidence->>'subject') between 1 and 512
      and (capability_evidence->>'imageDigest') ~ '^[a-f0-9]{64}$'
      and (capability_evidence->>'runnerDigest') ~ '^[a-f0-9]{64}$'
      and (capability_evidence->>'runtimeDigest') ~ '^[a-f0-9]{64}$'
      and octet_length(capability_evidence::text)<=8192
    )
  );

create function unfurl.guard_code_execution_capability_evidence() returns trigger language plpgsql set search_path = '' as $$
declare
  issued_at timestamptz;
  expires_at timestamptz;
begin
  if tg_op='INSERT' and new.capability_evidence is not null then
    raise exception 'Python capability evidence is recorded after admission' using errcode = '23514';
  end if;
  if tg_op='UPDATE' and old.capability_evidence is not null
    and new.capability_evidence is distinct from old.capability_evidence then
    raise exception 'Python capability evidence is immutable' using errcode = '23514';
  end if;
  if tg_op='UPDATE' and old.capability_evidence is null and new.capability_evidence is not null then
    if old.status<>'creating' or new.status<>'creating' then
      raise exception 'Python capability evidence must precede create' using errcode = '23514';
    end if;
    begin
      issued_at := (new.capability_evidence->>'issuedAt')::timestamptz;
      expires_at := (new.capability_evidence->>'expiresAt')::timestamptz;
    exception when others then
      raise exception 'Python capability evidence timestamps are invalid' using errcode = '23514';
    end;
    if issued_at>statement_timestamp()+interval '5 minutes' or expires_at<=statement_timestamp()
      or expires_at<=issued_at
      or new.capability_evidence->>'runtimeProfile'<>new.runtime_profile
      or new.capability_evidence->>'image'<>new.runtime_image
      or new.capability_evidence->>'imageDigest'<>new.image_digest
      or new.capability_evidence->>'runnerDigest'<>new.runner_digest
      or new.capability_evidence->>'runtimeDigest'<>new.runtime_digest then
      raise exception 'Python capability evidence does not authorize this execution' using errcode = '23514';
    end if;
  end if;
  if new.status in ('running','collecting','completed') and new.capability_evidence is null then
    raise exception 'Python sandbox creation requires capability evidence' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger code_execution_capability_evidence_guard before insert or update on unfurl.code_execution_runs
  for each row execute function unfurl.guard_code_execution_capability_evidence();
revoke all on function unfurl.guard_code_execution_capability_evidence() from public;
