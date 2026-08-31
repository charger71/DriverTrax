-- ============================================================
-- DriverTrax — SIPP / ACRISS class code catalog
--
-- Backs the SIPP picker in the driver app's plate/class editor
-- (vehicle-info.js) and Backlot's admin CRUD (backlot/sipp-codes.js).
-- Was a hardcoded list in vehicle-info.js; this table lets managers
-- add, rename, or retire codes without a code deploy. The driver app
-- falls back to that hardcoded list if this table doesn't exist yet
-- (schema not run) or the fetch fails, so nothing breaks mid-rollout.
--
-- Idempotent. Run in the Supabase SQL editor.
-- ============================================================

create table if not exists public.sipp_codes (
  code       text primary key,          -- e.g. "ECAR" — must match vehicles.sipp values
  label      text not null,             -- e.g. "Economy" — the only field managers edit
  created_at timestamptz not null default now()
);

comment on table public.sipp_codes is
  'SIPP/ACRISS rental class codes. code is the stable key (matches vehicles.sipp); label is the only editable field.';

alter table public.sipp_codes enable row level security;

-- Everyone signed in can read (the driver app's picker and Backlot's admin
-- table both need it); only managers/admins can write — same split as
-- parking_sections and service_vendors.
drop policy if exists "sipp_codes_select_authenticated" on public.sipp_codes;
create policy "sipp_codes_select_authenticated"
  on public.sipp_codes for select
  to authenticated
  using (true);

drop policy if exists "sipp_codes_insert_privileged" on public.sipp_codes;
create policy "sipp_codes_insert_privileged"
  on public.sipp_codes for insert
  to authenticated
  with check (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role in ('manager','admin')
    )
  );

drop policy if exists "sipp_codes_update_privileged" on public.sipp_codes;
create policy "sipp_codes_update_privileged"
  on public.sipp_codes for update
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

drop policy if exists "sipp_codes_delete_privileged" on public.sipp_codes;
create policy "sipp_codes_delete_privileged"
  on public.sipp_codes for delete
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role in ('manager','admin')
    )
  );

-- Seed with the codes already hardcoded in vehicle-info.js's SIPP_CODES, so
-- the driver app's picker and any existing vehicles.sipp values keep working
-- unchanged the moment this table exists — nothing to re-enter.
insert into public.sipp_codes (code, label) values
  ('ECAR',  'Economy'),
  ('CCAR',  'Compact'),
  ('ICAR',  'Intermediate / Midsize'),
  ('SCAR',  'Standard'),
  ('FCAR',  'Full Size'),
  ('PCAR',  'Premium'),
  ('LCAR',  'Luxury'),
  ('LDAR',  'Luxury (4-door)'),
  ('STAR',  'Convertible'),
  ('IFAR',  'Midsize SUV'),
  ('SFAR',  'SUV'),
  ('XPAR',  'Sport Utility'),
  ('IJAR',  'Intermediate All-Terrain 2 Door'),
  ('FJAR',  'Full Size All-Terrain 4 Door'),
  ('MVAR',  'Minivan'),
  ('GCAR',  'Minivan (Grand Caravan)'),
  ('XVARP', '15 Person Van')
on conflict (code) do nothing;
