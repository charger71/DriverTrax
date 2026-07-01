-- ============================================================
-- Backlot — privileged write access to `records`
--
-- Lets CXR / manager / admin INSERT / UPDATE / DELETE ANY record
-- (needed so the Backlot manager console can edit/create/delete
-- records that other users own). These are PERMISSIVE policies —
-- Postgres OR-combines them with the existing owner policies, so
-- drivers keep full control of their own rows and privileged roles
-- gain access to all rows.
--
-- Run in the Supabase SQL editor. Idempotent (drop-then-create).
-- ============================================================

-- Role check helper: is the current user a privileged role?
create or replace function public.is_privileged()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.role in ('cxr', 'manager', 'admin')
  );
$$;

alter table public.records enable row level security;

drop policy if exists "records_priv_insert" on public.records;
create policy "records_priv_insert" on public.records
  for insert to authenticated
  with check (public.is_privileged());

drop policy if exists "records_priv_update" on public.records;
create policy "records_priv_update" on public.records
  for update to authenticated
  using (public.is_privileged())
  with check (public.is_privileged());

drop policy if exists "records_priv_delete" on public.records;
create policy "records_priv_delete" on public.records
  for delete to authenticated
  using (public.is_privileged());

-- ------------------------------------------------------------
-- Storage: allow privileged roles to upload/read record photos
-- in the `vehicle-photos` bucket (in addition to any existing
-- owner policies). Adjust the bucket_id if your bucket differs.
-- ------------------------------------------------------------
drop policy if exists "vehicle_photos_priv_write" on storage.objects;
create policy "vehicle_photos_priv_write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'vehicle-photos' and public.is_privileged());

drop policy if exists "vehicle_photos_priv_update" on storage.objects;
create policy "vehicle_photos_priv_update" on storage.objects
  for update to authenticated
  using (bucket_id = 'vehicle-photos' and public.is_privileged());

drop policy if exists "vehicle_photos_priv_read" on storage.objects;
create policy "vehicle_photos_priv_read" on storage.objects
  for select to authenticated
  using (bucket_id = 'vehicle-photos' and public.is_privileged());
