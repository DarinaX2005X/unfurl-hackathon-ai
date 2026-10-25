-- Validation can end in an explicit uncertain receipt. Publication and task
-- materialization still require `passed`; receipts are immutable evidence.

alter table unfurl.version_validation_receipts
  drop constraint version_validation_receipts_verdict_check,
  add constraint version_validation_receipts_verdict_check check (verdict in ('passed', 'failed', 'uncertain'));
alter table unfurl.task_validation_receipts
  drop constraint task_validation_receipts_verdict_check,
  add constraint task_validation_receipts_verdict_check check (verdict in ('passed', 'failed', 'uncertain'));

create trigger version_validation_receipt_immutable before update or delete on unfurl.version_validation_receipts
  for each row execute function unfurl.reject_immutable_change();
create trigger task_validation_receipt_immutable before update or delete on unfurl.task_validation_receipts
  for each row execute function unfurl.reject_immutable_change();
