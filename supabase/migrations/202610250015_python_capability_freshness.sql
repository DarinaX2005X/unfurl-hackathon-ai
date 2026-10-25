-- Account/plan evidence is intentionally short-lived. Runtime admission also
-- matches the caller's exact configuration digest using database time.
alter table unfurl.execution_capability_receipts
  add constraint python_capability_short_lived check (
    capability <> 'python_sandbox' or expires_at <= observed_at + interval '5 minutes'
  );
