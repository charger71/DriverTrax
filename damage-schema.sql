-- ============================================================
-- DriverTrax damage + tire + claim schema (v2 — per-record model)
--
-- Damage marks, tire condition/PSI, and insurance claim info live on
-- the record row now (jsonb + text columns) instead of separate per-
-- vehicle tables. They're bundled into the INSERT when saveRecord()
-- runs and locked to that record afterward.
--
-- Fully idempotent — safe to re-run.
-- ============================================================

alter table public.records
  add column if not exists damage_marks jsonb   not null default '[]'::jsonb,
  add column if not exists tire_details jsonb   not null default '{}'::jsonb,
  add column if not exists claim_number text,
  add column if not exists claim_notes  text;

-- GIN index on damage_marks so per-vehicle aggregations
-- (e.g. "does this VIN have any damage on file") stay fast.
create index if not exists records_damage_marks_gin_idx
  on public.records using gin (damage_marks);

-- The v1 per-vehicle tables (vehicle_damage, vehicle_tires,
-- vehicle_claims) are left in place with their existing RLS so any
-- historical rows remain queryable, but no new writes happen from
-- damage.js anymore. Drop them when you're comfortable there's no
-- data you want to keep.
