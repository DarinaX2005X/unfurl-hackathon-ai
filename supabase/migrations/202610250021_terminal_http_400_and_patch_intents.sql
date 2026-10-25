-- A verified HTTP 400 response is terminal for concurrency only. The provider
-- operation and every financial hold remain UNKNOWN and unchanged.
create table unfurl.ai_provider_terminal_http_400_receipts (
  operation_id uuid primary key references unfurl.ai_provider_operations(id) on delete restrict,
  response_digest text not null check (response_digest ~ '^[a-f0-9]{64}$'),
  http_status integer not null check (http_status=400),
  evidence_digest text not null check (evidence_digest ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz not null,
  created_at timestamptz not null default now()
);
create trigger ai_provider_terminal_http_400_immutable before update or delete
  on unfurl.ai_provider_terminal_http_400_receipts
  for each row execute function unfurl.reject_immutable_change();

create function unfurl.record_ai_provider_terminal_http_400(
  p_operation_id uuid,
  p_response_digest text
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  operation_state text;
  response_record record;
  prior unfurl.ai_provider_terminal_http_400_receipts%rowtype;
  digest_value text;
begin
  select state into operation_state from unfurl.ai_provider_operations
    where id=p_operation_id for update;
  if not found or operation_state<>'unknown' then
    raise exception 'Provider operation is not an unknown terminal candidate' using errcode='23514';
  end if;
  select response_digest,result,received_at into response_record
    from unfurl.ai_provider_responses where operation_id=p_operation_id;
  if not found or response_record.response_digest is distinct from p_response_digest
    or jsonb_typeof(response_record.result)<>'object'
    or response_record.result->>'kind'<>'http_error'
    or response_record.result->'httpStatus' is distinct from '400'::jsonb then
    raise exception 'Provider response is not the exact observed HTTP 400' using errcode='23514';
  end if;
  digest_value := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
    'unfurl.ai_provider_terminal_http_400.v1:' || p_operation_id::text || ':' || p_response_digest,
    'UTF8'),'sha256'),'hex');
  select * into prior from unfurl.ai_provider_terminal_http_400_receipts
    where operation_id=p_operation_id;
  if found then
    if prior.response_digest<>p_response_digest or prior.http_status<>400
      or prior.evidence_digest<>digest_value or prior.observed_at<>response_record.received_at then
      raise exception 'Terminal HTTP 400 receipt identity conflict' using errcode='23514';
    end if;
    return prior.evidence_digest;
  end if;
  insert into unfurl.ai_provider_terminal_http_400_receipts
    (operation_id,response_digest,http_status,evidence_digest,observed_at)
    values(p_operation_id,p_response_digest,400,digest_value,response_record.received_at);
  return digest_value;
end;
$$;

alter table unfurl.ai_provider_terminal_http_400_receipts enable row level security;
alter table unfurl.ai_provider_terminal_http_400_receipts force row level security;
revoke all on unfurl.ai_provider_terminal_http_400_receipts from public,anon,authenticated,service_role;
grant select on unfurl.ai_provider_terminal_http_400_receipts to service_role;
revoke all on function unfurl.record_ai_provider_terminal_http_400(uuid,text)
  from public,anon,authenticated;
grant execute on function unfurl.record_ai_provider_terminal_http_400(uuid,text) to service_role;

-- One asynchronous PATCH run captures its complete typed command batch. The
-- normal idempotency receipt remains the HTTP acceptance authority.
create table unfurl.curriculum_patch_intents (
  run_id uuid primary key references unfurl.agent_turn_runs(id) on delete restrict,
  owner_id uuid not null references auth.users(id) on delete restrict,
  draft_id uuid not null references unfurl.curriculum_drafts(id) on delete restrict,
  expected_draft_revision integer not null check (expected_draft_revision>0),
  changes jsonb not null check (
    jsonb_typeof(changes)='array' and jsonb_array_length(changes) between 1 and 256
      and octet_length(changes::text)<=2000000
  ),
  created_at timestamptz not null default now()
);

create function unfurl.validate_curriculum_patch_intent() returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (
    select 1 from unfurl.agent_turn_runs run
    where run.id=new.run_id and run.owner_id=new.owner_id
  ) or not exists (
    select 1 from unfurl.curriculum_drafts draft join unfurl.courses course on course.id=draft.course_id
    where draft.id=new.draft_id and draft.revision=new.expected_draft_revision
      and draft.conversation_id=(select run.conversation_id from unfurl.agent_turn_runs run where run.id=new.run_id)
      and course.owner_id=new.owner_id
  ) then
    raise exception 'Curriculum patch intent identities do not agree' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger curriculum_patch_intent_identity before insert on unfurl.curriculum_patch_intents
  for each row execute function unfurl.validate_curriculum_patch_intent();
create trigger curriculum_patch_intent_immutable before update or delete on unfurl.curriculum_patch_intents
  for each row execute function unfurl.reject_immutable_change();

alter table unfurl.curriculum_patch_intents enable row level security;
alter table unfurl.curriculum_patch_intents force row level security;
revoke all on unfurl.curriculum_patch_intents from public,anon,authenticated;
grant all on unfurl.curriculum_patch_intents to service_role;
revoke all on function unfurl.validate_curriculum_patch_intent() from public;
