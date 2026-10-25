-- Append-only repair evidence for an already immutable provider response. This
-- table never changes provider-operation state or financial accounting.
create table unfurl.ai_provider_response_normalizations (
  operation_id uuid not null references unfurl.ai_provider_operations(id) on delete restrict,
  response_digest text not null check (response_digest ~ '^[a-f0-9]{64}$'),
  normalizer_version text not null check (normalizer_version='openrouter-native-usage-v2'),
  evidence_digest text not null check (evidence_digest ~ '^[a-f0-9]{64}$'),
  native_usage jsonb not null check (
    jsonb_typeof(native_usage)='object' and octet_length(native_usage::text)<=65536
  ),
  source_evidence jsonb not null check (
    jsonb_typeof(source_evidence)='object'
      and source_evidence ?& array['id','model','provider','usage','annotations']
      and source_evidence-array['id','model','provider','usage','annotations']='{}'::jsonb
      and octet_length(source_evidence::text)<=2097152
  ),
  created_at timestamptz not null default now(),
  primary key (operation_id,normalizer_version)
);

create function unfurl.validate_ai_provider_response_normalization() returns trigger language plpgsql set search_path = '' as $$
declare
  operation_record record;
  response_record record;
begin
  select state,purpose,model_id,provider_request_id into operation_record
    from unfurl.ai_provider_operations where id=new.operation_id;
  select response_digest,provider_request_id,reported_cost_usd,usage,result into response_record
    from unfurl.ai_provider_responses where operation_id=new.operation_id;
  if operation_record is null or response_record is null
    or operation_record.state<>'unknown'
    or operation_record.purpose not in ('web_search','capability_probe')
    or response_record.response_digest is distinct from new.response_digest
    or operation_record.provider_request_id is null
    or response_record.provider_request_id is distinct from operation_record.provider_request_id
    or new.source_evidence->>'id' is distinct from operation_record.provider_request_id
    or new.source_evidence->>'model' is distinct from operation_record.model_id
    or new.source_evidence->>'provider' is distinct from response_record.result->>'provider'
    or response_record.result->>'model' is distinct from operation_record.model_id
    or new.source_evidence->'usage' is distinct from new.native_usage
    or new.native_usage->>'cost' is distinct from response_record.reported_cost_usd
    or new.native_usage->>'prompt_tokens' is distinct from response_record.usage->>'promptTokens'
    or new.native_usage->>'completion_tokens' is distinct from response_record.usage->>'completionTokens'
    or new.native_usage->>'total_tokens' is distinct from response_record.usage->>'totalTokens'
    or new.native_usage#>>'{prompt_tokens_details,cached_tokens}' is distinct from response_record.usage->>'cachedPromptTokens'
    or new.native_usage#>>'{completion_tokens_details,reasoning_tokens}' is distinct from response_record.usage->>'reasoningTokens'
    or coalesce(response_record.usage->>'searchRequests','')<>'0'
    or new.native_usage#>>'{server_tool_use_details,web_search_requests}'<>'1'
    or new.native_usage#>>'{server_tool_use_details,tool_calls_requested}'<>'1'
    or new.native_usage#>>'{server_tool_use_details,tool_calls_executed}'<>'1'
    or coalesce(new.native_usage#>>'{cost_details,upstream_inference_cost}','') !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$'
    or (new.native_usage->>'prompt_tokens')::integer+(new.native_usage->>'completion_tokens')::integer
      <> (new.native_usage->>'total_tokens')::integer then
    raise exception 'Provider normalization does not bind the immutable response' using errcode='23514';
  end if;
  if jsonb_typeof(new.source_evidence->'annotations')<>'array'
    or jsonb_typeof(response_record.result->'annotations')<>'array'
    or jsonb_array_length(new.source_evidence->'annotations')
      <> jsonb_array_length(response_record.result->'annotations')
    or exists (
      select 1
      from jsonb_array_elements(new.source_evidence->'annotations') with ordinality native(item,position)
      join jsonb_array_elements(response_record.result->'annotations') with ordinality stored(item,position)
        using(position)
      where native.item->>'type'<>'url_citation'
        or native.item#>>'{url_citation,url}' is distinct from stored.item->>'url'
        or native.item#>>'{url_citation,title}' is distinct from stored.item->>'title'
        or coalesce(native.item#>>'{url_citation,content}','') is distinct from stored.item->>'content'
    ) then
    raise exception 'Provider normalization citations do not bind the immutable response' using errcode='23514';
  end if;
  return new;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception 'Provider normalization counters are invalid' using errcode='23514';
end;
$$;
create trigger ai_provider_response_normalization_identity before insert
  on unfurl.ai_provider_response_normalizations
  for each row execute function unfurl.validate_ai_provider_response_normalization();
create trigger ai_provider_response_normalization_immutable before update or delete
  on unfurl.ai_provider_response_normalizations
  for each row execute function unfurl.reject_immutable_change();

alter table unfurl.ai_provider_response_normalizations enable row level security;
alter table unfurl.ai_provider_response_normalizations force row level security;
revoke all on unfurl.ai_provider_response_normalizations from public,anon,authenticated;
grant all on unfurl.ai_provider_response_normalizations to service_role;
revoke all on function unfurl.validate_ai_provider_response_normalization() from public;
