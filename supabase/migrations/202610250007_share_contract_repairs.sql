-- Align the persisted share-key identity and publication pointer with the accepted access contract.
-- Refuse inconsistent existing rows rather than repairing or discarding access state blindly.
do $$ begin
  if exists (
    select 1 from unfurl.courses
    where (visibility = 'public') <> (published_version_id is not null)
  ) then
    raise exception 'Existing course publication state needs explicit repair' using errcode = '23514';
  end if;
end $$;

alter table unfurl.courses
  add constraint course_publication_pointer_iff_public
  check ((visibility = 'public') = (published_version_id is not null));

alter table unfurl.share_grants
  drop constraint share_grants_key_version_check,
  alter column key_version drop default;
alter table unfurl.share_grants
  alter column key_version type text using key_version::text;
alter table unfurl.share_grants rename column key_version to token_key_version;
alter table unfurl.share_grants
  alter column token_key_version set default '1',
  add constraint share_grant_token_key_version
    check (token_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$');
