-- ============================================================
-- DriverTrax parking sections + drop-off geotagging
--
-- Backs the "which lot section did this vehicle end up in?"
-- feature described in docs/parking-sections-spec.md. Uses
-- PostGIS on Supabase so lat/lng containment is a single query.
--
-- Two tables:
--   parking_sections — polygons authored by managers in a Leaflet
--                      tool (Backlot, QTA, Garage, …).
--   drop_offs        — one row per drop-off; a BEFORE INSERT trigger
--                      auto-tags section_id from the point.
--
-- Idempotent. Run in the Supabase SQL editor.
--
-- Adaptations from the spec (docs/parking-sections-spec.md):
--   * vehicles.id doesn't exist — vehicles is keyed by
--     `serial_id text`. `drop_offs` mirrors that with `serial_id`.
--   * No `fleets` table yet, so `parking_sections.fleet_id` is a
--     plain uuid column (no FK) — safe to add the FK later.
-- ============================================================

create extension if not exists postgis;

-- ----- parking_sections --------------------------------------------------
create table if not exists public.parking_sections (
  id         uuid primary key default gen_random_uuid(),
  fleet_id   uuid,
  name       text not null,                         -- "Backlot", "QTA", "Garage"
  status     text not null default 'open',          -- open | full | restricted
  boundary   geography(Polygon, 4326) not null,
  created_at timestamptz not null default now()
);

create index if not exists parking_sections_boundary_idx
  on public.parking_sections using gist (boundary);

-- View that exposes each polygon as GeoJSON so the driver app can render
-- boundaries on the shift map and run client-side point-in-polygon checks
-- (for the GPS/dropdown conflict prompt). Views inherit RLS from the base
-- table, so no extra policies needed.
create or replace view public.parking_sections_geo as
  select id, name, status,
         ST_AsGeoJSON(boundary::geometry)::jsonb as geojson
    from public.parking_sections;

-- Newly created views don't inherit the base table's PostgREST grants,
-- so `sb.from("parking_sections_geo").select(...)` would 404 without
-- this. Nudge PostgREST to notice the view immediately.
grant select on public.parking_sections_geo to authenticated, anon;
notify pgrst, 'reload schema';

alter table public.parking_sections enable row level security;

-- Everyone signed in can read section polygons (drivers need them for
-- rendering + the auto-tag trigger reads them under security definer).
drop policy if exists "parking_sections_select_authenticated" on public.parking_sections;
create policy "parking_sections_select_authenticated"
  on public.parking_sections for select
  to authenticated
  using (true);

-- Only managers / admins can add or edit sections — matches how the
-- manager Leaflet tool is gated on the driver app side.
drop policy if exists "parking_sections_insert_privileged" on public.parking_sections;
create policy "parking_sections_insert_privileged"
  on public.parking_sections for insert
  to authenticated
  with check (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role in ('manager','admin')
    )
  );

drop policy if exists "parking_sections_update_privileged" on public.parking_sections;
create policy "parking_sections_update_privileged"
  on public.parking_sections for update
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

drop policy if exists "parking_sections_delete_privileged" on public.parking_sections;
create policy "parking_sections_delete_privileged"
  on public.parking_sections for delete
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role in ('manager','admin')
    )
  );

-- ----- drop_offs ---------------------------------------------------------
-- serial_id lines up with public.vehicles(serial_id). Nullable so early
-- inserts from the driver app don't fail if the vehicles row hasn't been
-- upserted yet by the records trigger.
create table if not exists public.drop_offs (
  id            uuid primary key default gen_random_uuid(),
  serial_id     text references public.vehicles(serial_id) on delete set null,
  location      geography(Point, 4326) not null,
  section_id    uuid references public.parking_sections(id) on delete set null,
  location_name text,                                       -- driver-entered fallback
  record_id     text,                                       -- link back to the records row that triggered the drop-off
  user_id       uuid,                                       -- who dropped it
  created_at    timestamptz not null default now()
);

create index if not exists drop_offs_serial_idx
  on public.drop_offs (serial_id, created_at desc);
create index if not exists drop_offs_section_idx
  on public.drop_offs (section_id);
create index if not exists drop_offs_created_idx
  on public.drop_offs (created_at desc);

alter table public.drop_offs enable row level security;

-- Any authenticated user can read/insert their own drop-offs; updates are
-- restricted to the row's owner so the "Where is this?" prompt can only
-- name the drop-off the current driver just created.
drop policy if exists "drop_offs_select_authenticated" on public.drop_offs;
create policy "drop_offs_select_authenticated"
  on public.drop_offs for select
  to authenticated
  using (true);

drop policy if exists "drop_offs_insert_authenticated" on public.drop_offs;
create policy "drop_offs_insert_authenticated"
  on public.drop_offs for insert
  to authenticated
  with check (user_id is null or user_id = auth.uid());

drop policy if exists "drop_offs_update_own_or_privileged" on public.drop_offs;
create policy "drop_offs_update_own_or_privileged"
  on public.drop_offs for update
  to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role in ('manager','admin')
    )
  )
  with check (
    user_id = auth.uid()
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role in ('manager','admin')
    )
  );

-- ----- Auto-tag section on insert ---------------------------------------
-- BEFORE INSERT trigger sets new.section_id if the point falls inside
-- any polygon. security definer so the trigger can read parking_sections
-- regardless of the caller's RLS scope.
create or replace function public.tag_drop_off_section()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.location is null then
    return new;
  end if;
  select id into new.section_id
    from public.parking_sections
    where ST_Contains(boundary::geometry, new.location::geometry)
    limit 1;
  return new;
end;
$$;

drop trigger if exists set_section on public.drop_offs;
create trigger set_section
  before insert on public.drop_offs
  for each row
  execute function public.tag_drop_off_section();

-- ----- Write-back to records / vehicles ---------------------------------
-- The driver app shows a "Location" chip on every record card (fleet view,
-- VIN detail, today feed, dashboard). Existing screens read `destination`
-- from the records/vehicles tables — they don't know about drop_offs.
--
-- To make GPS-tagged section names show up in those screens for free, we
-- carry two extra columns on records + vehicles:
--   section_id   — matches the drop_offs row's tagged polygon (nullable)
--   section_name — human label, either the polygon's name or the driver-
--                  entered fallback from the "Where is this?" prompt.
--
-- drop-offs.js writes these into the local record on the client, and
-- sync.js round-trips them. On the DB side, the records-trigger already
-- propagates record columns to vehicles, so we just need the columns.
alter table public.records
  add column if not exists section_id   uuid,
  add column if not exists section_name text;
alter table public.vehicles
  add column if not exists section_id   uuid,
  add column if not exists section_name text;

-- Extend fn_records_sync_vehicle() so vehicle rows track the latest
-- section stamp too. Re-runs the same "only advance on newer ts" guard.
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
      vin_data, needs_new_tag,
      section_id, section_name,
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
      now()
    );
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

drop trigger if exists trg_records_sync_vehicle on public.records;
create trigger trg_records_sync_vehicle
  after insert or update on public.records
  for each row
  execute function public.fn_records_sync_vehicle();

-- ============================================================
-- Retag helper (for polygons added AFTER a drop-off happened)
--
-- The tag_drop_off_section trigger fires BEFORE INSERT only, so a
-- drop-off from before its section polygon existed stays orphaned
-- (section_id null, location_name maybe set, section_name missing on
-- records). Managers can call this any time to sweep through:
--
--   select public.retag_drop_offs();
--
-- It only writes to rows it actually improves — never clobbers a
-- section_id that's already set. Returns the number of drop-offs
-- newly tagged so you can see the impact.
-- ============================================================
create or replace function public.retag_drop_offs()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  -- Step 1: tag drop_offs whose point sits in a polygon but weren't
  -- tagged before (polygon didn't exist yet, or driver skipped the
  -- prompt without a match).
  update public.drop_offs d
     set section_id = ps.id
    from public.parking_sections ps
   where d.section_id is null
     and d.location is not null
     and ST_Contains(ps.boundary::geometry, d.location::geometry);

  -- Step 2: propagate section_id / section_name to the linked records
  -- row wherever it's stale. Prefers polygon name; falls back to the
  -- driver's typed location_name when no polygon matched.
  with dp as (
    select d.record_id,
           d.section_id,
           coalesce(ps.name, d.location_name) as section_name
      from public.drop_offs d
      left join public.parking_sections ps on ps.id = d.section_id
     where d.record_id is not null
  )
  update public.records r
     set section_id   = dp.section_id,
         section_name = dp.section_name
    from dp
   where r.id = dp.record_id
     and (r.section_id  is distinct from dp.section_id
       or r.section_name is distinct from dp.section_name);

  get diagnostics n = row_count;
  return n;
end;
$$;

grant execute on function public.retag_drop_offs() to authenticated;

-- ============================================================
-- Backfill: pre-existing records that have GPS but predate this
-- feature. Two-step so you can eyeball what would change first.
--
-- STEP 1 (preview) — run this to see which records the ST_Contains
-- would tag. It reads-only; nothing is written.
--
--   select r.id, r.serial_id, r.destination, ps.name as detected_section,
--          r.ts, r.lat, r.lng
--     from public.records r
--     join public.parking_sections ps
--       on ST_Contains(
--            ps.boundary::geometry,
--            ST_SetSRID(ST_MakePoint(r.lng, r.lat), 4326)::geometry
--          )
--    where r.section_name is null
--      and r.lat is not null and r.lng is not null
--    order by r.ts desc;
--
-- STEP 2 (apply) — when you're happy with the preview:
--
--   update public.records r
--      set section_id   = ps.id,
--          section_name = ps.name
--     from public.parking_sections ps
--    where r.section_name is null
--      and r.lat is not null and r.lng is not null
--      and ST_Contains(
--            ps.boundary::geometry,
--            ST_SetSRID(ST_MakePoint(r.lng, r.lat), 4326)::geometry
--          );
--
-- The vehicles trigger fires on records UPDATE, so vehicles.section_*
-- catches up automatically.
-- ============================================================
