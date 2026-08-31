-- ============================================================
-- DriverTrax — reconcile a full-VIN scan against an Inventory
-- Import placeholder row.
--
-- Background: inventory-import.js seeds `vehicles` rows keyed by
-- Enterprise's short VIN code (the last 8 characters of the real
-- 17-digit VIN — position 10 model year + 11 plant + 12-17 serial),
-- for cars that haven't been scanned by a driver yet. When a driver
-- later scans the same car, the real flow captures the FULL VIN, a
-- different string, so the existing trigger would create a second,
-- disconnected `vehicles` row and strand the imported plate/SIPP/
-- mileage/hold_codes/etc. on the orphaned placeholder forever.
--
-- Fix: when fn_records_sync_vehicle() is about to insert a brand
-- new vehicles row for a full (17-char) serial_id, look for an
-- 8-char placeholder whose serial_id is that VIN's last 8
-- characters. If one exists, fold its import-only columns into the
-- new row and delete the placeholder — the trigger runs `security
-- definer`, so it can delete it even though the calling driver's
-- own session has no delete grant on `vehicles` (there is no
-- vehicles delete policy, by design — this is the one narrow,
-- server-side exception).
--
-- Idempotent (create or replace). Run in the Supabase SQL editor.
-- Full function body reproduced (not a diff) since CREATE OR
-- REPLACE FUNCTION replaces the whole thing — this is the complete,
-- current version as of the parking-sections section_id/section_name
-- addition, with the placeholder-reconcile step added.
-- ============================================================

create or replace function public.fn_records_sync_vehicle()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.vehicles%rowtype;
  v_ghost    public.vehicles%rowtype;
begin
  if new.serial_id is null or new.serial_id = '' then
    return new;
  end if;

  select * into v_existing
    from public.vehicles
    where serial_id = new.serial_id;

  if not found then
    if length(new.serial_id) = 17 then
      select * into v_ghost
        from public.vehicles
        where serial_id = right(new.serial_id, 8)
          and length(serial_id) = 8;
    end if;

    insert into public.vehicles (
      serial_id,
      current_status, current_status_other,
      current_destination, current_destination_other,
      current_conditions,
      last_lat, last_lng,
      last_seen_at, last_user_id, last_record_id,
      entered_inventory_at, entered_by,
      vin_data, needs_new_tag,
      section_id, section_name,
      plate, plate_state, sipp,
      unit_number, mileage, hold_codes,
      description, last_location_note, expected_return,
      imported_at, imported_by,
      updated_at
    ) values (
      new.serial_id,
      new.status, new.status_other,
      new.destination, new.destination_other,
      new.conditions,
      new.lat, new.lng,
      new.ts, new.user_id, new.id,
      coalesce(new.ts, now()), new.user_id,
      new.vin_data, coalesce(new.no_tag, false),
      new.section_id, new.section_name,
      v_ghost.plate, v_ghost.plate_state, v_ghost.sipp,
      v_ghost.unit_number, v_ghost.mileage, v_ghost.hold_codes,
      v_ghost.description, v_ghost.last_location_note, v_ghost.expected_return,
      v_ghost.imported_at, v_ghost.imported_by,
      now()
    );

    if v_ghost.serial_id is not null then
      delete from public.vehicles where serial_id = v_ghost.serial_id;
    end if;

    return new;
  end if;

  if v_existing.last_seen_at is null
     or new.ts is null
     or new.ts >= v_existing.last_seen_at then
    update public.vehicles set
      current_status            = new.status,
      current_status_other      = new.status_other,
      current_destination       = new.destination,
      current_destination_other = new.destination_other,
      current_conditions        = coalesce(new.conditions, v_existing.current_conditions),
      last_lat                  = coalesce(new.lat, v_existing.last_lat),
      last_lng                  = coalesce(new.lng, v_existing.last_lng),
      last_seen_at              = coalesce(new.ts, v_existing.last_seen_at),
      last_user_id              = new.user_id,
      last_record_id            = new.id,
      vin_data                  = coalesce(new.vin_data, v_existing.vin_data),
      needs_new_tag             = coalesce(new.no_tag, v_existing.needs_new_tag),
      section_id                = coalesce(new.section_id,   v_existing.section_id),
      section_name              = coalesce(new.section_name, v_existing.section_name),
      updated_at                = now()
      where serial_id = new.serial_id;
  else
    if v_existing.vin_data is null and new.vin_data is not null then
      update public.vehicles
        set vin_data = new.vin_data, updated_at = now()
        where serial_id = new.serial_id;
    end if;
  end if;

  return new;
end;
$$;

-- Trigger definition unchanged — re-stated only so this file is a complete,
-- standalone re-run of the whole mechanism, matching the other *-schema.sql
-- files' convention.
drop trigger if exists trg_records_sync_vehicle on public.records;
create trigger trg_records_sync_vehicle
  after insert or update on public.records
  for each row
  execute function public.fn_records_sync_vehicle();
