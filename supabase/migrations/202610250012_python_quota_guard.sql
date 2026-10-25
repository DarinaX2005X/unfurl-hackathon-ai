-- PostgreSQL record fields are table-specific even inside a short-circuited
-- expression. Branch before reading learner_id so the global counter can update.
create or replace function unfurl.guard_python_quota_counter() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Python quota counters are monotonic' using errcode = '23514';
  end if;
  if tg_table_name = 'python_execution_learner_daily_quotas' then
    if new.quota_day is distinct from old.quota_day or new.learner_id is distinct from old.learner_id
      or new.reserved_count < old.reserved_count then
      raise exception 'Python quota counters are monotonic' using errcode = '23514';
    end if;
  elsif new.quota_day is distinct from old.quota_day or new.reserved_count < old.reserved_count then
    raise exception 'Python quota counters are monotonic' using errcode = '23514';
  end if;
  return new;
end;
$$;
