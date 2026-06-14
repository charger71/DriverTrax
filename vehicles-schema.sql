-- ============================================================
-- DriverTrax `vehicles` table — current-state inventory per VIN
--
-- Run this in the Supabase SQL editor. Idempotent (uses IF NOT
-- EXISTS / CREATE OR REPLACE) — safe to re-run.
--
-- Design:
--   - `records` stays the append-only event log (driver scans,
--     detailer DETAILING/DETAILED rows, etc.).
--   - `vehicles` holds one row per VIN with current status,
--     location, and the timestamp of the latest record that
--     produced that state.
--   - An AFTER INSERT/UPDATE trigger on `records` maintains
--     `vehicles` automatically. Driver and detailer code paths
--     don't need to know `vehicles` exists.
--   - `entered_inventory_at` / `entered_by` are set once, on the
--     very first record for a VIN (i.e. "new inventory").
-- ============================================================

create table if not exists public.vehicles (
  serial_id                 text primary key,
  current_status            text,
  current_status_other      text,
  current_destination       text,
  current_destination_other text,
  current_conditions        text[],
  last_lat                  double precision,
  last_lng                  double precision,
  last_seen_at              timestamptz,
  last_user_id              uuid,
  last_record_id            text,
  entered_inventory_at      timestamptz not null default now(),
  entered_by                uuid,
  vin_data                  jsonb,
  updated_at                timestamptz not null default now()
);

-- Safe to re-run after the initial create — adds the conditions column on
-- existing installs.
alter table public.vehicles
  add column if not exists current_conditions text[];

-- Records also carries the conditions array (saved with CXR CHECK_IN entries).
alter table public.records
  add column if not exists conditions text[];

-- Bad Tag flag carried through to the vehicle row so inventory views can
-- surface "cars needing a new tag". Latest record wins.
alter table public.vehicles
  add column if not exists needs_new_tag boolean not null default false;

create index if not exists vehicles_last_seen_idx
  on public.vehicles (last_seen_at desc);
create index if not exists vehicles_status_idx
  on public.vehicles (current_status);

-- ----- RLS: any authenticated user can read + write -----
alter table public.vehicles enable row level security;

drop policy if exists "vehicles_select_authenticated" on public.vehicles;
create policy "vehicles_select_authenticated"
  on public.vehicles for select
  to authenticated
  using (true);

drop policy if exists "vehicles_insert_authenticated" on public.vehicles;
create policy "vehicles_insert_authenticated"
  on public.vehicles for insert
  to authenticated
  with check (true);

drop policy if exists "vehicles_update_authenticated" on public.vehicles;
create policy "vehicles_update_authenticated"
  on public.vehicles for update
  to authenticated
  using (true)
  with check (true);

-- ----- Trigger: keep `vehicles` in sync with `records` -----
-- Fires on every records INSERT or UPDATE. Upserts vehicles, but
-- only overwrites the current-state columns when the incoming
-- record's ts is at least as new as what we already have. That
-- way out-of-order syncs (offline driver flushes late) can't
-- clobber a newer detailer DETAILED stamp.
create or replace function public.fn_records_sync_vehicle()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.vehicles%rowtype;
begin
  if new.serial_id is null or new.serial_id = '' then
    return new;
  end if;

  select * into v_existing
    from public.vehicles
    where serial_id = new.serial_id;

  if not found then
    insert into public.vehicles (
      serial_id,
      current_status, current_status_other,
      current_destination, current_destination_other,
      current_conditions,
      last_lat, last_lng,
      last_seen_at, last_user_id, last_record_id,
      entered_inventory_at, entered_by,
      vin_data, needs_new_tag, updated_at
    ) values (
      new.serial_id,
      new.status, new.status_other,
      new.destination, new.destination_other,
      new.conditions,
      new.lat, new.lng,
      new.ts, new.user_id, new.id,
      coalesce(new.ts, now()), new.user_id,
      new.vin_data, coalesce(new.no_tag, false), now()
    );
    return new;
  end if;

  -- Only advance current-state columns if this record is newer
  -- than (or equal to) what's already there. Equal handles the
  -- detailer two-row case where DETAILING and DETAILED can share
  -- a ts under racy clock conditions.
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
      updated_at                = now()
      where serial_id = new.serial_id;
  else
    -- Older record arriving late: still let it fill in vin_data
    -- if we don't have any yet.
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

-- ============================================================
-- Backfill: seed `vehicles` from existing `records` history.
-- Picks the most recent record per serial_id for current state,
-- and the earliest for entered_inventory_at / entered_by.
-- Safe to re-run — it's an upsert.
-- ============================================================
with latest as (
  select distinct on (serial_id)
    serial_id, status, status_other, destination, destination_other,
    lat, lng, ts, user_id, id, vin_data
  from public.records
  where serial_id is not null and serial_id <> ''
  order by serial_id, ts desc nulls last
),
earliest as (
  select distinct on (serial_id)
    serial_id, ts, user_id
  from public.records
  where serial_id is not null and serial_id <> ''
  order by serial_id, ts asc nulls last
)
insert into public.vehicles (
  serial_id,
  current_status, current_status_other,
  current_destination, current_destination_other,
  last_lat, last_lng,
  last_seen_at, last_user_id, last_record_id,
  entered_inventory_at, entered_by,
  vin_data, updated_at
)
select
  l.serial_id,
  l.status, l.status_other,
  l.destination, l.destination_other,
  l.lat, l.lng,
  l.ts, l.user_id, l.id,
  coalesce(e.ts, l.ts, now()), coalesce(e.user_id, l.user_id),
  l.vin_data, now()
from latest l
left join earliest e on e.serial_id = l.serial_id
on conflict (serial_id) do update set
  current_status            = excluded.current_status,
  current_status_other      = excluded.current_status_other,
  current_destination       = excluded.current_destination,
  current_destination_other = excluded.current_destination_other,
  last_lat                  = excluded.last_lat,
  last_lng                  = excluded.last_lng,
  last_seen_at              = excluded.last_seen_at,
  last_user_id              = excluded.last_user_id,
  last_record_id            = excluded.last_record_id,
  entered_inventory_at      = least(public.vehicles.entered_inventory_at, excluded.entered_inventory_at),
  vin_data                  = coalesce(excluded.vin_data, public.vehicles.vin_data),
  updated_at                = now();
