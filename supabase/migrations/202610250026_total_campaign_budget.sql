-- Explicitly approved total campaign cap: USD 20 including all prior spend.
-- Keep the same campaign, its USD 0.50 safety reserve and every accounting record.
-- The migration runner applies these statements in one transaction.
alter table unfurl.ai_budgets
  drop constraint ai_budgets_hard_limit_micro_usd_check,
  drop constraint ai_budgets_spendable_limit_micro_usd_check,
  alter column hard_limit_micro_usd set default 20000000,
  alter column spendable_limit_micro_usd set default 19500000;

update unfurl.ai_budgets
set hard_limit_micro_usd = 20000000,
    spendable_limit_micro_usd = 19500000,
    revision = revision + 1,
    updated_at = now();

alter table unfurl.ai_budgets
  add constraint ai_budgets_hard_limit_micro_usd_check check (hard_limit_micro_usd = 20000000),
  add constraint ai_budgets_spendable_limit_micro_usd_check check (spendable_limit_micro_usd = 19500000);
