-- ============================================================
-- DriverTrax — Delete Vehicle / Archive Vehicle (Backlot)
--
-- Archive: adds archived_at/archived_by to `vehicles`. Hides the row
-- from Backlot's + the driver app's browse/search (see backlot/vehicles.js,
-- backlot/records.js, and the three filtered app.js query sites). Fully
-- reversible, and auto-cleared the next time a real driver record lands
-- for the VIN (see the fn_records_sync_vehicle() change below) — a real
-- scan is evidence the car is back in service.
--
-- Delete: there is still no delete policy on `vehicles` (by design, see
-- vehicle-vin-suffix-reconcile-schema.sql) — the delete_vehicle() RPC
-- below is the one client-callable way in, mirroring how
-- fn_records_sync_vehicle() already deletes an absorbed placeholder via
-- security definer. Blocks entirely if the vehicle has any reference in
-- records, service_jobs, or drop_offs (service_jobs in particular has no
-- FK protecting it) — it's a cleanup tool for junk/duplicate/placeholder
-- rows, not a general-purpose delete.
--
-- Idempotent. Run in the Supabase SQL editor.
-- ============================================================

alter table public.vehicles
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid;

comment on column public.vehicles.archived_at is
  'When this vehicle was hidden from Backlot + driver-app browse/search. Null = active. Cleared automatically by fn_records_sync_vehicle() the next time a real driver scan lands for this VIN.';
comment on column public.vehicles.archived_by is
  'profiles.id of the manager/admin who archived it. No FK, matching entered_by/imported_by/last_user_id on this table.';

create index if not exists vehicles_archived_at_idx
  on public.vehicles (archived_at) where archived_at is not null;

-- ----- delete_vehicle RPC ---------------------------------------------
-- p_dry_run:true is a read-only reference-count check — same query the
-- real delete uses, so there's exactly one implementation of the "blocked
-- if referenced" rule, not a JS copy that could drift from this one.
create or replace function public.delete_vehicle(p_serial_id text, p_dry_run boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_records_count      integer;
  v_service_jobs_count integer;
  v_drop_offs_count    integer;
begin
  -- Re-checked server-side — the Backlot UI only ever shows Delete to
  -- admins, but a non-admin could still call this RPC directly.
  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  ) then
    raise exception 'Only an admin can delete a vehicle.' using errcode = '42501';
  end if;

  if p_serial_id is null or p_serial_id = '' then
    raise exception 'serial_id is required.';
  end if;

  select count(*) into v_records_count      from public.records      where serial_id = p_serial_id;
  select count(*) into v_service_jobs_count from public.service_jobs where serial_id = p_serial_id;
  select count(*) into v_drop_offs_count    from public.drop_offs    where serial_id = p_serial_id;

  if p_dry_run then
    return jsonb_build_object(
      'serial_id',    p_serial_id,
      'records',      v_records_count,
      'service_jobs', v_service_jobs_count,
      'drop_offs',    v_drop_offs_count,
      'blocked',      (v_records_count + v_service_jobs_count + v_drop_offs_count) > 0
    );
  end if;

  if v_records_count > 0 or v_service_jobs_count > 0 or v_drop_offs_count > 0 then
    raise exception 'Cannot delete %: % record(s), % service job(s), % drop-off(s) still reference it.',
      p_serial_id, v_records_count, v_service_jobs_count, v_drop_offs_count;
  end if;

  delete from public.vehicles where serial_id = p_serial_id;
  if not found then
    raise exception 'Vehicle % not found.', p_serial_id;
  end if;

  return jsonb_build_object('serial_id', p_serial_id, 'deleted', true);
end;
$$;

grant execute on function public.delete_vehicle(text, boolean) to authenticated;

-- ----- fn_records_sync_vehicle(): auto-un-archive on a real scan -------
-- Full body reproduced (create or replace replaces the whole function) —
-- identical to the current version in vehicle-vin-suffix-reconcile-schema.sql,
-- with one addition: archived_at/archived_by cleared in the main
-- state-advancing UPDATE (the record that's actually asserting current
-- state). The narrower out-of-order backfill branch is left untouched —
-- it isn't asserting "this car is active now," so it shouldn't carry the
-- un-archive side effect.
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
      archived_at               = null,
      archived_by               = null,
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

drop trigger if exists trg_records_sync_vehicle on public.records;
create trigger trg_records_sync_vehicle
  after insert or update on public.records
  for each row
  execute function public.fn_records_sync_vehicle();
