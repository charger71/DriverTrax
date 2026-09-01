-- ============================================================
-- DriverTrax — one-time merge of Inventory Import placeholder rows
-- into their matching real-VIN vehicles rows.
--
-- Background: fn_records_sync_vehicle() (vehicle-vin-suffix-reconcile
-- -schema.sql) only merges a placeholder that already exists at the
-- moment a real scan's records row is inserted. It has no way to
-- retroactively catch a placeholder created by a *later* import run
-- for a car that had already been scanned — and until today,
-- inventory-import.js's own suffix-match in buildPlan() wasn't
-- reliably catching that direction either. Result: 181 cars ended up
-- as two disconnected vehicles rows (an 8-char placeholder and the
-- real 17-char VIN), with the real row often missing the plate/SIPP/
-- mileage/description that only ever landed on the placeholder.
--
-- This is a one-time data cleanup, not a schema change (named
-- *-schema.sql only so it isn't gitignored, matching this repo's
-- other *.sql files). Safe to re-run: once no placeholder/real pairs
-- remain, the loop simply does nothing.
--
-- Run in the Supabase SQL editor.
-- ============================================================

do $$
declare
  r record;
  v_pairs_merged   int := 0;
  v_records_moved  int := 0;
  v_jobs_moved     int := 0;
  v_dropoffs_moved int := 0;
  v_n              int;
begin
  for r in
    select p.serial_id as placeholder_id, f.serial_id as real_id
    from public.vehicles p
    join public.vehicles f
      on length(p.serial_id) = 8
     and length(f.serial_id) = 17
     and right(f.serial_id, 8) = p.serial_id
  loop
    -- Re-point anything still referencing the placeholder's short id onto
    -- the real VIN before the placeholder goes away. records has an
    -- on-delete-set-null FK to vehicles — skipping this step would silently
    -- null out serial_id on any record still pointing at the placeholder.
    -- service_jobs has no FK at all, so it would just go quietly orphaned
    -- (unfindable by VIN) instead.
    update public.records set serial_id = r.real_id where serial_id = r.placeholder_id;
    get diagnostics v_n = row_count; v_records_moved := v_records_moved + v_n;

    update public.service_jobs set serial_id = r.real_id where serial_id = r.placeholder_id;
    get diagnostics v_n = row_count; v_jobs_moved := v_jobs_moved + v_n;

    update public.drop_offs set serial_id = r.real_id where serial_id = r.placeholder_id;
    get diagnostics v_n = row_count; v_dropoffs_moved := v_dropoffs_moved + v_n;

    -- Fill-if-blank only — the real row's own values always win. Mirrors
    -- buildVehicleUpdatePayload()'s treatment of plate/state/sipp in
    -- inventory-import.js, extended to every import-owned column.
    update public.vehicles real_v
    set
      plate              = coalesce(real_v.plate, ph.plate),
      plate_state        = coalesce(real_v.plate_state, ph.plate_state),
      sipp               = coalesce(real_v.sipp, ph.sipp),
      unit_number        = coalesce(real_v.unit_number, ph.unit_number),
      mileage            = coalesce(real_v.mileage, ph.mileage),
      hold_codes         = coalesce(real_v.hold_codes, ph.hold_codes),
      description        = coalesce(real_v.description, ph.description),
      last_location_note = coalesce(real_v.last_location_note, ph.last_location_note),
      expected_return    = coalesce(real_v.expected_return, ph.expected_return),
      imported_at        = coalesce(real_v.imported_at, ph.imported_at),
      imported_by        = coalesce(real_v.imported_by, ph.imported_by),
      updated_at         = now()
    from public.vehicles ph
    where real_v.serial_id = r.real_id
      and ph.serial_id = r.placeholder_id;

    delete from public.vehicles where serial_id = r.placeholder_id;
    v_pairs_merged := v_pairs_merged + 1;
  end loop;

  raise notice 'Merged % duplicate pair(s); re-pointed % records row(s), % service_jobs row(s), % drop_offs row(s)',
    v_pairs_merged, v_records_moved, v_jobs_moved, v_dropoffs_moved;
end $$;

-- Verify: should return 0 rows once the merge above has run.
select p.serial_id as leftover_placeholder, f.serial_id as real_vin
from public.vehicles p
join public.vehicles f
  on length(p.serial_id) = 8
 and length(f.serial_id) = 17
 and right(f.serial_id, 8) = p.serial_id;
