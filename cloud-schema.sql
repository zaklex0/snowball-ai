-- Run once in the SQL Editor of your own Supabase project.
-- Each account can read only its own records and immutable attachments.
create table if not exists public.snowball_records (
  owner uuid not null references auth.users(id) on delete cascade,
  key text not null check (length(key) between 1 and 300),
  version bigint not null default 1,
  payload jsonb,
  primary key (owner, key)
);
alter table public.snowball_records enable row level security;
revoke all on public.snowball_records from anon, authenticated;
grant select on public.snowball_records to authenticated;
drop policy if exists snowball_read on public.snowball_records;
create policy snowball_read on public.snowball_records for select to authenticated using (owner = (select auth.uid()));

-- The version check and write happen under one lock, including first creation.
create or replace function public.snowball_put(p_key text, p_expected bigint, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); r public.snowball_records; result jsonb;
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if length(p_key) not between 1 and 300 or p_expected < 0 then raise exception 'Invalid input'; end if;
  if octet_length(p_payload::text) > 10000000 then raise exception 'Record too large'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text || ':' || p_key, 0));
  select * into r from public.snowball_records where owner = uid and key = p_key;
  if coalesce(r.version, 0) <> p_expected then
    return jsonb_build_object('ok', false, 'record', jsonb_build_object('key', p_key, 'version', coalesce(r.version, 0), 'payload', r.payload));
  end if;
  insert into public.snowball_records(owner, key, version, payload) values(uid, p_key, p_expected + 1, p_payload)
    on conflict(owner, key) do update set version = excluded.version, payload = excluded.payload
    returning to_jsonb(snowball_records.*) into result;
  return jsonb_build_object('ok', true, 'record', result);
end $$;
revoke all on function public.snowball_put(text, bigint, jsonb) from public, anon;
grant execute on function public.snowball_put(text, bigint, jsonb) to authenticated;

insert into storage.buckets(id, name, public, file_size_limit)
values ('snowball-files', 'snowball-files', false, 20971520) on conflict(id) do update set public = false, file_size_limit = excluded.file_size_limit;
drop policy if exists snowball_files_read on storage.objects;
drop policy if exists snowball_files_add on storage.objects;
create policy snowball_files_read on storage.objects for select to authenticated
  using(bucket_id = 'snowball-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy snowball_files_add on storage.objects for insert to authenticated
  with check(bucket_id = 'snowball-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
