-- ============================================================
-- DriverTrax car maintenance / mechanics schema
--
-- Two tables:
--   service_vendors — outside shops (body, glass, tire, dealer, ...)
--                     that in-lot mechanics route work to. Manager/
--                     admin-managed catalog, same shape as
--                     parking_sections in parking-sections-schema.sql.
--   service_jobs    — one row per work order. Shop-wide (any mechanic
--                     can see/continue any job — a work order can span
--                     shifts and outlive whoever opened it), paired
--                     with `records` rows at each meaningful transition
--                     (opened / sent out / returned / closed) the same
--                     way detail_jobs pairs with records for detailers.
--
-- No manager-approval gate on the vendor lifecycle at this time — a
-- mechanic can send a car out and bring it back without a sign-off
-- step. Parts are a freeform list (jsonb array of strings), not an
-- ordering/receiving workflow.
--
-- Idempotent. Run in the Supabase SQL editor.
-- ============================================================

-- ----- service_vendors ----------------------------------------------------
create table if not exists public.service_vendors (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  vendor_type  text not null default 'other', -- body | glass | tire | dealer | general | other
  contact_name text,
  phone        text,
  address      text,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

-- One row per unique name, case-insensitive — mirrors the parking_sections
-- de-dupe guard so a double-tapped Save can't create two "Bo's Body Shop" rows.
create unique index if not exists service_vendors_name_lower_idx
  on public.service_vendors (lower(name));

alter table public.service_vendors enable row level security;

drop policy if exists "service_vendors_select_authenticated" on public.service_vendors;
create policy "service_vendors_select_authenticated"
  on public.service_vendors for select
  to authenticated
  using (true);

-- Only managers / admins manage the vendor catalog — matches how the
-- Locations panel is gated on the driver app side.
drop policy if exists "service_vendors_insert_privileged" on public.service_vendors;
create policy "service_vendors_insert_privileged"
  on public.service_vendors for insert
  to authenticated
  with check (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role in ('manager','admin')
    )
  );

drop policy if exists "service_vendors_update_privileged" on public.service_vendors;
create policy "service_vendors_update_privileged"
  on public.service_vendors for update
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role in ('manager','admin')
    )
  )
  with check (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role in ('manager','admin')
    )
  );

drop policy if exists "service_vendors_delete_privileged" on public.service_vendors;
create policy "service_vendors_delete_privileged"
  on public.service_vendors for delete
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role in ('manager','admin')
    )
  );

-- ----- service_jobs --------------------------------------------------------
create table if not exists public.service_jobs (
  id                 uuid primary key default gen_random_uuid(),
  serial_id          text not null,
  job_type           text not null,               -- PM | MK | MR | OM | TI | LP | BODY | GLASS
  performed_by       text not null default 'in_house' check (performed_by in ('in_house','vendor')),
  vendor_id          uuid references public.service_vendors(id),
  state              text not null default 'OPEN' check (state in ('OPEN','SENT_OUT','RETURNED','CLOSED')),
  destination        text,                         -- on-lot spot the vehicle sits at (mirrors records.destination)
  mileage            integer,
  notes              text,
  parts              jsonb not null default '[]'::jsonb,  -- freeform list of part descriptions
  opened_by          uuid,
  opened_at          timestamptz not null default now(),
  sent_out_at        timestamptz,
  returned_at        timestamptz,
  closed_at          timestamptz,
  close_status       text,                         -- status recorded on the vehicle when the job closes
  open_record_id     text,                          -- links to the `records` row opened alongside this job
  sent_out_record_id text,
  returned_record_id text,
  close_record_id    text,
  updated_at         timestamptz not null default now()
);

create index if not exists service_jobs_serial_idx on public.service_jobs (serial_id);
create index if not exists service_jobs_state_idx  on public.service_jobs (state);
create index if not exists service_jobs_vendor_idx on public.service_jobs (vendor_id);

alter table public.service_jobs enable row level security;

-- Shop-wide, any-authenticated-user access — same reasoning as `vehicles`
-- in vehicles-schema.sql: a work order isn't scoped to whoever opened it,
-- so per-owner RLS would just get in the way of a second mechanic picking
-- up where the first left off.
drop policy if exists "service_jobs_select_authenticated" on public.service_jobs;
create policy "service_jobs_select_authenticated"
  on public.service_jobs for select
  to authenticated
  using (true);

drop policy if exists "service_jobs_insert_authenticated" on public.service_jobs;
create policy "service_jobs_insert_authenticated"
  on public.service_jobs for insert
  to authenticated
  with check (true);

drop policy if exists "service_jobs_update_authenticated" on public.service_jobs;
create policy "service_jobs_update_authenticated"
  on public.service_jobs for update
  to authenticated
  using (true)
  with check (true);

-- No delete policy: nothing in the mechanic UI deletes a job. Restricted to
-- mechanic/cxr/manager/admin via the Supabase SQL editor if cleanup is ever
-- needed — everyone else already can't reach the table minus RLS at all.
drop policy if exists "service_jobs_delete_privileged" on public.service_jobs;
create policy "service_jobs_delete_privileged"
  on public.service_jobs for delete
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role in ('mechanic','cxr','manager','admin')
    )
  );

-- Keep updated_at current on every mutation.
create or replace function public.fn_service_jobs_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_service_jobs_touch on public.service_jobs;
create trigger trg_service_jobs_touch
  before update on public.service_jobs
  for each row
  execute function public.fn_service_jobs_touch();
