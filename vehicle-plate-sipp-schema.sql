-- ============================================================
-- DriverTrax — license plate + SIPP class on `vehicles`
--
-- Run this in the Supabase SQL editor. Idempotent (IF NOT EXISTS
-- everywhere) — safe to re-run.
--
-- Why `vehicles` and not `records`:
--   `records` is the append-only event log — one row per scan. A
--   plate, its issuing state, and the SIPP class code are properties
--   of the car, not of the visit, so they belong on the one-row-per-VIN
--   table alongside `vin_data`. Nothing has to re-enter them on the
--   next scan.
--
-- The `fn_records_sync_vehicle` trigger never writes these three
-- columns, so a later record for the same VIN can't clobber them.
-- ============================================================

alter table public.vehicles add column if not exists plate       text;
alter table public.vehicles add column if not exists plate_state text;
alter table public.vehicles add column if not exists sipp        text;

comment on column public.vehicles.plate       is 'License plate, uppercase, no spaces (e.g. KDX4471).';
comment on column public.vehicles.plate_state is 'Two-letter issuing state / territory code (e.g. NY).';
comment on column public.vehicles.sipp        is 'SIPP / ACRISS class code (e.g. ICAR). See the Car SIPP Codes table in the Training panel.';

-- Plate lookup is case-insensitive (drivers type lowercase), so index the
-- uppercased value — that's the expression the search path uses.
create index if not exists vehicles_plate_idx on public.vehicles (upper(plate));
create index if not exists vehicles_sipp_idx  on public.vehicles (sipp);

-- RLS is unchanged: vehicles_select_authenticated / _update_authenticated /
-- _insert_authenticated already cover these columns for any signed-in user.
