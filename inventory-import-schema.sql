-- ============================================================
-- DriverTrax Inventory Import — columns backing the manager/admin
-- "Import Inventory" tool (inventory-import.js), which bulk-loads
-- fleet data pasted from Google Sheets (Available / Rented /
-- In-Maintenance) into `vehicles` and, for the maintenance sheet,
-- `service_jobs`.
--
-- Idempotent. Run in the Supabase SQL editor.
-- ============================================================

alter table public.vehicles
  add column if not exists unit_number        text,
  add column if not exists mileage            integer,
  -- Distinct vocabulary from current_conditions (PET_HAIR/SPIFFY/...) —
  -- these are Enterprise's own hold/reason codes, aliased onto
  -- DriverTrax status codes where the two already overlap.
  add column if not exists hold_codes         text[],
  add column if not exists description        text,
  add column if not exists last_location_note text,
  add column if not exists expected_return    date,
  -- Last-known import stamp, same style as entered_inventory_at/updated_at —
  -- not an audit log, just "was this row ever touched by an import, and by
  -- whom" so a future pass can tell imported data from real scan data.
  add column if not exists imported_at        timestamptz,
  add column if not exists imported_by        uuid;

alter table public.service_jobs
  add column if not exists ecd date;

-- Cleanup: this file originally added its own license_plate/registration_state/
-- sipp_code columns before vehicle-plate-sipp-schema.sql's plate/plate_state/sipp
-- landed on main (same data, different feature branches). The importer now
-- writes those columns instead — drop the redundant ones here so a fresh
-- project run of this file doesn't recreate the duplication, and so an
-- already-migrated project (which had these columns briefly) gets cleaned up
-- on the next run.
alter table public.vehicles
  drop column if exists license_plate,
  drop column if exists registration_state,
  drop column if exists sipp_code;
