-- ============================================================
-- DriverTrax — full database bootstrap
--
-- Recreates every table, view, function, trigger, index, RLS
-- policy, storage bucket, and realtime registration the app
-- depends on. Run top to bottom on a fresh Supabase project and
-- the app boots against it.
--
-- Idempotent throughout (create ... if not exists / or replace,
-- drop-then-create for policies), so it is also safe to run on an
-- existing project to fill in whatever is missing.
--
-- ------------------------------------------------------------
-- HOW THIS FILE WAS BUILT — READ BEFORE TRUSTING IT
-- ------------------------------------------------------------
-- It is a RECONSTRUCTION, not a dump of production. It merges:
--
--   (a) the tracked per-feature *-schema.sql files, which are
--       exact — copied verbatim; and
--   (b) tables that were created by hand in the Supabase
--       dashboard and never tracked here, whose definitions are
--       INFERRED from what the app reads and writes.
--
-- Every section below is marked [EXACT] or [INFERRED]. For the
-- inferred ones the COLUMN NAMES are reliable (the app names them
-- explicitly in its selects and inserts) but these are guesses:
--
--   * column types and NOT NULL / DEFAULT choices
--   * RLS policies — INFERRED POLICIES ARE A SECURITY DECISION.
--     Nothing in the repo records what production actually has.
--     Read every policy in an [INFERRED] section and confirm it
--     matches your intent before relying on it.
--   * CHECK constraints, and any column the app never touches
--
-- To get an authoritative dump of the live database instead:
--
--   supabase login
--   supabase link --project-ref wcetkygfsstqtlmrijjl
--   supabase db dump -f schema.sql --schema public
--
-- Diffing that against this file is the fastest way to find where
-- the reconstruction drifted from reality.
-- ============================================================


-- ============================================================
-- EXTENSIONS
-- ============================================================
create extension if not exists postgis;   -- parking_sections.boundary, drop_offs.location
create extension if not exists pgcrypto;  -- gen_random_uuid()


-- ============================================================
-- PROFILES                                        [INFERRED]
--
-- One row per auth user, created by the on_auth_user_created
-- trigger below. auth.js relies on that trigger: signUp() only
-- UPDATEs display_name afterward, so without it a new account has
-- no profile row and every role check fails closed.
--
-- Columns are collected from the app's select lists (users.js,
-- app.js, auth.js) and the admin-users edge function.
-- The role CHECK is [EXACT] — profiles-mechanic-role-schema.sql.
-- ============================================================
create table if not exists public.profiles (
  id               uuid primary key references auth.users(id) on delete cascade,
  display_name     text,
  email            text,
  phone            text,
  role             text not null default 'driver',
  shuttle_subrole  text,
  home_airport     text,
  callbacks_opt_in boolean not null default false,
  avatar_url       text,
  theme_preference text,
  approved         boolean not null default false,
  disabled         boolean not null default false,
  created_at       timestamptz not null default now()
);

alter table public.profiles
  drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check
  check (role in ('driver', 'cxr', 'detailer', 'mechanic', 'manager', 'admin'));

alter table public.profiles
  drop constraint if exists profiles_theme_preference_check;
alter table public.profiles
  add constraint profiles_theme_preference_check
  check (theme_preference is null or theme_preference in ('system', 'dark', 'light'));

create index if not exists profiles_approved_idx on public.profiles (approved) where approved = false;
create index if not exists profiles_disabled_idx on public.profiles (disabled) where disabled = true;
create index if not exists profiles_role_idx     on public.profiles (role);

-- Auto-create the profile row on signup. Referenced by auth.js's
-- comment in onSignUp(); security definer so it can write past RLS.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name, role, approved)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(coalesce(new.email, ''), '@', 1)),
    'driver',
    false
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

alter table public.profiles enable row level security;

-- Every signed-in user reads profiles: contact cards, record author
-- names, and the leaderboard all resolve display_name by id.
drop policy if exists "profiles_select_authenticated" on public.profiles;
create policy "profiles_select_authenticated"
  on public.profiles for select to authenticated using (true);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- The Users panel (users.js) edits other people's rows.
drop policy if exists "profiles_update_privileged" on public.profiles;
create policy "profiles_update_privileged"
  on public.profiles for update to authenticated
  using (
    exists (select 1 from public.profiles p
             where p.id = auth.uid() and p.role in ('cxr','manager','admin'))
  )
  with check (
    exists (select 1 from public.profiles p
             where p.id = auth.uid() and p.role in ('cxr','manager','admin'))
  );


-- ============================================================
-- Role helper                                        [EXACT]
-- records-write-access-schema.sql. Defined after profiles
-- because it reads them.
-- ============================================================
create or replace function public.is_privileged()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.role in ('cxr', 'manager', 'admin')
  );
$$;


-- ============================================================
-- RECORDS                                         [INFERRED]
--
-- The append-only event log — one row per scan. Column list is
-- taken from sync.js toRow(), which is the complete write shape,
-- plus the columns added by the tracked feature schemas
-- (damage/tire/claim, photo_urls, conditions, section_*).
--
-- `id` is text, not uuid: the client generates it offline
-- (crypto.randomUUID() or a timestamp-random fallback) so a queued
-- record keeps one identity from IndexedDB through to Postgres.
-- ============================================================
create table if not exists public.records (
  id                text primary key,
  user_id           uuid references auth.users(id) on delete set null,
  serial_id         text not null default '',
  status            text,
  status_other      text,
  destination       text,
  destination_other text,
  section_id        uuid,
  section_name      text,
  no_tag            boolean not null default false,
  shuttle           boolean not null default false,
  transport         boolean not null default false,
  shift_num         integer,
  notes             text,
  lat               double precision,
  lng               double precision,
  gps_error         boolean not null default false,
  tires             text[],
  conditions        text[],
  vin_data          jsonb,
  mileage           integer,
  fuel_level        text,
  photo_url         text,
  photo_urls        jsonb,
  damage_marks      jsonb not null default '[]'::jsonb,
  tire_details      jsonb not null default '{}'::jsonb,
  claim_number      text,
  claim_notes       text,
  ts                timestamptz not null default now()
);

create index if not exists records_serial_idx  on public.records (serial_id);
create index if not exists records_ts_idx      on public.records (ts desc);
create index if not exists records_user_ts_idx on public.records (user_id, ts desc);
create index if not exists records_status_idx  on public.records (status);
create index if not exists records_damage_marks_gin_idx
  on public.records using gin (damage_marks);

alter table public.records enable row level security;

-- Fleet-wide read: VIN lookup and fuzzy search span every user's
-- records, not just the caller's.
drop policy if exists "records_select_authenticated" on public.records;
create policy "records_select_authenticated"
  on public.records for select to authenticated using (true);

-- Owner writes. Combined by OR with the privileged policies below.
drop policy if exists "records_own_insert" on public.records;
create policy "records_own_insert"
  on public.records for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists "records_own_update" on public.records;
create policy "records_own_update"
  on public.records for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "records_own_delete" on public.records;
create policy "records_own_delete"
  on public.records for delete to authenticated
  using (user_id = auth.uid());

-- [EXACT] — records-write-access-schema.sql. PERMISSIVE, so these
-- OR-combine with the owner policies above: drivers keep their own
-- rows, privileged roles reach all rows.
drop policy if exists "records_priv_insert" on public.records;
create policy "records_priv_insert" on public.records
  for insert to authenticated
  with check (public.is_privileged());

drop policy if exists "records_priv_update" on public.records;
create policy "records_priv_update" on public.records
  for update to authenticated
  using (public.is_privileged())
  with check (public.is_privileged());

drop policy if exists "records_priv_delete" on public.records;
create policy "records_priv_delete" on public.records
  for delete to authenticated
  using (public.is_privileged());


-- ============================================================
-- VEHICLES                                           [EXACT]
-- vehicles-schema.sql + the section_* columns from
-- parking-sections-schema.sql + vehicle-plate-sipp-schema.sql.
-- One row per VIN, maintained by a trigger on records.
-- ============================================================
create table if not exists public.vehicles (
  serial_id                 text primary key,
  current_status            text,
  current_status_other      text,
  current_destination       text,
  current_destination_other text,
  current_conditions        text[],
  section_id                uuid,
  section_name              text,
  last_lat                  double precision,
  last_lng                  double precision,
  last_seen_at              timestamptz,
  last_user_id              uuid,
  last_record_id            text,
  entered_inventory_at      timestamptz not null default now(),
  entered_by                uuid,
  vin_data                  jsonb,
  needs_new_tag             boolean not null default false,
  plate                     text,
  plate_state               text,
  sipp                      text,
  updated_at                timestamptz not null default now()
);

comment on column public.vehicles.plate       is 'License plate, uppercase, no spaces (e.g. KDX4471).';
comment on column public.vehicles.plate_state is 'Two-letter issuing state / territory code (e.g. NY).';
comment on column public.vehicles.sipp        is 'SIPP / ACRISS class code (e.g. ICAR). See the Car SIPP Codes table in the Training panel.';

create index if not exists vehicles_last_seen_idx on public.vehicles (last_seen_at desc);
create index if not exists vehicles_status_idx    on public.vehicles (current_status);
create index if not exists vehicles_plate_idx     on public.vehicles (upper(plate));
create index if not exists vehicles_sipp_idx      on public.vehicles (sipp);

alter table public.vehicles enable row level security;

drop policy if exists "vehicles_select_authenticated" on public.vehicles;
create policy "vehicles_select_authenticated"
  on public.vehicles for select to authenticated using (true);

drop policy if exists "vehicles_insert_authenticated" on public.vehicles;
create policy "vehicles_insert_authenticated"
  on public.vehicles for insert to authenticated with check (true);

drop policy if exists "vehicles_update_authenticated" on public.vehicles;
create policy "vehicles_update_authenticated"
  on public.vehicles for update to authenticated using (true) with check (true);


-- ============================================================
-- records -> vehicles sync trigger                   [EXACT]
--
-- The extended version from parking-sections-schema.sql (carries
-- section_id / section_name), which supersedes the original in
-- vehicles-schema.sql.
--
-- Only advances the current-state columns when the incoming record
-- is at least as new as what's stored, so an offline driver
-- flushing late can't clobber a newer detailer stamp. Note it never
-- writes plate / plate_state / sipp — those are edited directly and
-- must survive later scans.
-- ============================================================
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
-- PARKING SECTIONS + GEO VIEW                        [EXACT]
-- parking-sections-schema.sql. boundary is nullable: managers add
-- "name-only" locations from the driver app that have no polygon.
-- ============================================================
create table if not exists public.parking_sections (
  id         uuid primary key default gen_random_uuid(),
  fleet_id   uuid,
  name       text not null,
  status     text not null default 'open',   -- open | full | restricted
  boundary   geography(Polygon, 4326),
  created_at timestamptz not null default now()
);

alter table public.parking_sections alter column boundary drop not null;

create index if not exists parking_sections_boundary_idx
  on public.parking_sections using gist (boundary);
create unique index if not exists parking_sections_name_lower_idx
  on public.parking_sections (lower(name));

-- Polygons as GeoJSON for the shift map + client-side point-in-polygon.
-- Views inherit RLS from the base table, so no extra policies.
create or replace view public.parking_sections_geo as
  select id, name, status,
         case when boundary is null then null
              else ST_AsGeoJSON(boundary::geometry)::jsonb
         end as geojson
    from public.parking_sections;

-- Views don't inherit the base table's PostgREST grants; without
-- this, selecting the view 404s.
grant select on public.parking_sections_geo to authenticated, anon;

alter table public.parking_sections enable row level security;

drop policy if exists "parking_sections_select_authenticated" on public.parking_sections;
create policy "parking_sections_select_authenticated"
  on public.parking_sections for select to authenticated using (true);

drop policy if exists "parking_sections_insert_privileged" on public.parking_sections;
create policy "parking_sections_insert_privileged"
  on public.parking_sections for insert to authenticated
  with check (
    exists (select 1 from public.profiles p
             where p.id = auth.uid() and p.role in ('manager','admin'))
  );

drop policy if exists "parking_sections_update_privileged" on public.parking_sections;
create policy "parking_sections_update_privileged"
  on public.parking_sections for update to authenticated
  using (
    exists (select 1 from public.profiles p
             where p.id = auth.uid() and p.role in ('manager','admin'))
  )
  with check (
    exists (select 1 from public.profiles p
             where p.id = auth.uid() and p.role in ('manager','admin'))
  );

drop policy if exists "parking_sections_delete_privileged" on public.parking_sections;
create policy "parking_sections_delete_privileged"
  on public.parking_sections for delete to authenticated
  using (
    exists (select 1 from public.profiles p
             where p.id = auth.uid() and p.role in ('manager','admin'))
  );


-- ============================================================
-- DROP OFFS                                          [EXACT]
-- parking-sections-schema.sql
-- ============================================================
create table if not exists public.drop_offs (
  id            uuid primary key default gen_random_uuid(),
  serial_id     text references public.vehicles(serial_id) on delete set null,
  location      geography(Point, 4326) not null,
  section_id    uuid references public.parking_sections(id) on delete set null,
  location_name text,
  record_id     text,
  user_id       uuid,
  created_at    timestamptz not null default now()
);

create index if not exists drop_offs_serial_idx  on public.drop_offs (serial_id, created_at desc);
create index if not exists drop_offs_section_idx on public.drop_offs (section_id);
create index if not exists drop_offs_created_idx on public.drop_offs (created_at desc);

alter table public.drop_offs enable row level security;

drop policy if exists "drop_offs_select_authenticated" on public.drop_offs;
create policy "drop_offs_select_authenticated"
  on public.drop_offs for select to authenticated using (true);

drop policy if exists "drop_offs_insert_authenticated" on public.drop_offs;
create policy "drop_offs_insert_authenticated"
  on public.drop_offs for insert to authenticated
  with check (user_id is null or user_id = auth.uid());

drop policy if exists "drop_offs_update_own_or_privileged" on public.drop_offs;
create policy "drop_offs_update_own_or_privileged"
  on public.drop_offs for update to authenticated
  using (
    user_id = auth.uid()
    or exists (select 1 from public.profiles p
                where p.id = auth.uid() and p.role in ('manager','admin'))
  )
  with check (
    user_id = auth.uid()
    or exists (select 1 from public.profiles p
                where p.id = auth.uid() and p.role in ('manager','admin'))
  );

-- BEFORE INSERT: stamp section_id if the point falls inside a polygon.
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

-- Sweep helper for polygons drawn AFTER a drop-off happened. The
-- insert trigger can't reach those. Call: select public.retag_drop_offs();
create or replace function public.retag_drop_offs()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  update public.drop_offs d
     set section_id = ps.id
    from public.parking_sections ps
   where d.section_id is null
     and d.location is not null
     and ST_Contains(ps.boundary::geometry, d.location::geometry);

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
-- SERVICE VENDORS                                    [EXACT]
-- maintenance-schema.sql + maintenance-vendor-address-schema.sql
-- ============================================================
create table if not exists public.service_vendors (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  vendor_type  text not null default 'other',  -- body | glass | tire | dealer | general | other
  contact_name text,
  phone        text,
  address      text,
  city         text,
  state        text,
  zip          text,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

create unique index if not exists service_vendors_name_lower_idx
  on public.service_vendors (lower(name));

alter table public.service_vendors enable row level security;

drop policy if exists "service_vendors_select_authenticated" on public.service_vendors;
create policy "service_vendors_select_authenticated"
  on public.service_vendors for select to authenticated using (true);

drop policy if exists "service_vendors_insert_privileged" on public.service_vendors;
create policy "service_vendors_insert_privileged"
  on public.service_vendors for insert to authenticated
  with check (
    exists (select 1 from public.profiles p
             where p.id = auth.uid() and p.role in ('manager','admin'))
  );

drop policy if exists "service_vendors_update_privileged" on public.service_vendors;
create policy "service_vendors_update_privileged"
  on public.service_vendors for update to authenticated
  using (
    exists (select 1 from public.profiles p
             where p.id = auth.uid() and p.role in ('manager','admin'))
  )
  with check (
    exists (select 1 from public.profiles p
             where p.id = auth.uid() and p.role in ('manager','admin'))
  );

drop policy if exists "service_vendors_delete_privileged" on public.service_vendors;
create policy "service_vendors_delete_privileged"
  on public.service_vendors for delete to authenticated
  using (
    exists (select 1 from public.profiles p
             where p.id = auth.uid() and p.role in ('manager','admin'))
  );


-- ============================================================
-- SERVICE JOBS                                       [EXACT]
-- maintenance-schema.sql + the waiting-parts, updated-by, and
-- notes-log/actions addenda.
-- ============================================================
create table if not exists public.service_jobs (
  id                   uuid primary key default gen_random_uuid(),
  serial_id            text not null,
  job_type             text not null,   -- PM | MK | MR | OM | TI | LP | BODY | GLASS
  performed_by         text not null default 'in_house'
                         check (performed_by in ('in_house','vendor')),
  vendor_id            uuid references public.service_vendors(id),
  state                text not null default 'OPEN'
                         check (state in ('OPEN','SENT_OUT','RETURNED','CLOSED')),
  destination          text,
  mileage              integer,
  notes                text,
  notes_log            jsonb not null default '[]'::jsonb,
  service_actions      jsonb not null default '[]'::jsonb,
  service_action_other text,
  parts                jsonb not null default '[]'::jsonb,
  waiting_on_parts     boolean not null default false,
  parts_note           text,
  waiting_since        timestamptz,
  opened_by            uuid,
  updated_by           uuid,
  opened_at            timestamptz not null default now(),
  sent_out_at          timestamptz,
  returned_at          timestamptz,
  closed_at            timestamptz,
  close_status         text,
  open_record_id       text,
  sent_out_record_id   text,
  returned_record_id   text,
  close_record_id      text,
  updated_at           timestamptz not null default now()
);

create index if not exists service_jobs_serial_idx  on public.service_jobs (serial_id);
create index if not exists service_jobs_state_idx   on public.service_jobs (state);
create index if not exists service_jobs_vendor_idx  on public.service_jobs (vendor_id);
create index if not exists service_jobs_waiting_idx on public.service_jobs (waiting_on_parts)
  where waiting_on_parts = true;

alter table public.service_jobs enable row level security;

-- Shop-wide by design: a work order outlives whoever opened it, so
-- per-owner RLS would block a second mechanic picking it up.
drop policy if exists "service_jobs_select_authenticated" on public.service_jobs;
create policy "service_jobs_select_authenticated"
  on public.service_jobs for select to authenticated using (true);

drop policy if exists "service_jobs_insert_authenticated" on public.service_jobs;
create policy "service_jobs_insert_authenticated"
  on public.service_jobs for insert to authenticated with check (true);

drop policy if exists "service_jobs_update_authenticated" on public.service_jobs;
create policy "service_jobs_update_authenticated"
  on public.service_jobs for update to authenticated using (true) with check (true);

drop policy if exists "service_jobs_delete_privileged" on public.service_jobs;
create policy "service_jobs_delete_privileged"
  on public.service_jobs for delete to authenticated
  using (
    exists (select 1 from public.profiles p
             where p.id = auth.uid() and p.role in ('mechanic','cxr','manager','admin'))
  );

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


-- ============================================================
-- DETAIL JOBS                                     [INFERRED]
--
-- One row per detail. detailer.js writes detailer_id, serial_id,
-- condition_tags, todo_state, record_id and later stamps
-- completed_at; it never writes started_at, so that defaults.
-- An open job is completed_at IS NULL — that's the query the
-- detailer landing screen runs.
-- ============================================================
create table if not exists public.detail_jobs (
  id             uuid primary key default gen_random_uuid(),
  detailer_id    uuid references auth.users(id) on delete set null,
  serial_id      text not null,
  condition_tags text[] not null default '{}',
  todo_state     jsonb  not null default '[]'::jsonb,
  record_id      text,
  started_at     timestamptz not null default now(),
  completed_at   timestamptz
);

create index if not exists detail_jobs_serial_idx   on public.detail_jobs (serial_id);
create index if not exists detail_jobs_detailer_idx on public.detail_jobs (detailer_id, started_at desc);
create index if not exists detail_jobs_open_idx     on public.detail_jobs (started_at desc)
  where completed_at is null;

alter table public.detail_jobs enable row level security;

-- Fleet-wide read: the Backlot dashboard counts active detailers
-- across everyone, not just the caller.
drop policy if exists "detail_jobs_select_authenticated" on public.detail_jobs;
create policy "detail_jobs_select_authenticated"
  on public.detail_jobs for select to authenticated using (true);

drop policy if exists "detail_jobs_insert_own" on public.detail_jobs;
create policy "detail_jobs_insert_own"
  on public.detail_jobs for insert to authenticated
  with check (detailer_id = auth.uid() or public.is_privileged());

drop policy if exists "detail_jobs_update_own_or_privileged" on public.detail_jobs;
create policy "detail_jobs_update_own_or_privileged"
  on public.detail_jobs for update to authenticated
  using (detailer_id = auth.uid() or public.is_privileged())
  with check (detailer_id = auth.uid() or public.is_privileged());


-- ============================================================
-- ANNOUNCEMENTS + REPLIES + REACTIONS             [INFERRED]
--
-- announcements.js reads id, body, created_at, expires_at,
-- author_id, status and filters on status = 'open'. Expiry is
-- applied client-side against expires_at, so the column is
-- nullable and nothing sweeps it server-side.
-- ============================================================
create table if not exists public.announcements (
  id         uuid primary key default gen_random_uuid(),
  author_id  uuid references auth.users(id) on delete set null,
  body       text not null,
  status     text not null default 'open',
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists announcements_status_created_idx
  on public.announcements (status, created_at desc);

alter table public.announcements enable row level security;

drop policy if exists "announcements_select_authenticated" on public.announcements;
create policy "announcements_select_authenticated"
  on public.announcements for select to authenticated using (true);

-- Posting and closing announcements is a manager-console action.
drop policy if exists "announcements_insert_privileged" on public.announcements;
create policy "announcements_insert_privileged"
  on public.announcements for insert to authenticated
  with check (public.is_privileged());

drop policy if exists "announcements_update_privileged" on public.announcements;
create policy "announcements_update_privileged"
  on public.announcements for update to authenticated
  using (public.is_privileged()) with check (public.is_privileged());

drop policy if exists "announcements_delete_privileged" on public.announcements;
create policy "announcements_delete_privileged"
  on public.announcements for delete to authenticated
  using (public.is_privileged());


create table if not exists public.announcement_replies (
  id              uuid primary key default gen_random_uuid(),
  announcement_id uuid not null references public.announcements(id) on delete cascade,
  author_id       uuid references auth.users(id) on delete set null,
  body            text not null,
  created_at      timestamptz not null default now()
);

create index if not exists announcement_replies_ann_idx
  on public.announcement_replies (announcement_id, created_at);

alter table public.announcement_replies enable row level security;

drop policy if exists "announcement_replies_select_authenticated" on public.announcement_replies;
create policy "announcement_replies_select_authenticated"
  on public.announcement_replies for select to authenticated using (true);

-- Any signed-in user replies; only the author (or a privileged
-- role) can remove a reply.
drop policy if exists "announcement_replies_insert_own" on public.announcement_replies;
create policy "announcement_replies_insert_own"
  on public.announcement_replies for insert to authenticated
  with check (author_id = auth.uid());

drop policy if exists "announcement_replies_delete_own_or_privileged" on public.announcement_replies;
create policy "announcement_replies_delete_own_or_privileged"
  on public.announcement_replies for delete to authenticated
  using (author_id = auth.uid() or public.is_privileged());


-- One reaction per (announcement, user, emoji) — announcements.js
-- toggles by looking for an existing row and deleting it.
create table if not exists public.announcement_reactions (
  id              uuid primary key default gen_random_uuid(),
  announcement_id uuid not null references public.announcements(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  emoji           text not null,
  created_at      timestamptz not null default now()
);

create unique index if not exists announcement_reactions_unique_idx
  on public.announcement_reactions (announcement_id, user_id, emoji);
create index if not exists announcement_reactions_ann_idx
  on public.announcement_reactions (announcement_id);

alter table public.announcement_reactions enable row level security;

drop policy if exists "announcement_reactions_select_authenticated" on public.announcement_reactions;
create policy "announcement_reactions_select_authenticated"
  on public.announcement_reactions for select to authenticated using (true);

drop policy if exists "announcement_reactions_insert_own" on public.announcement_reactions;
create policy "announcement_reactions_insert_own"
  on public.announcement_reactions for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists "announcement_reactions_delete_own" on public.announcement_reactions;
create policy "announcement_reactions_delete_own"
  on public.announcement_reactions for delete to authenticated
  using (user_id = auth.uid());


-- ============================================================
-- EXTRA DRIVER REQUESTS + RESPONSES               [INFERRED]
--
-- A manager asks for extra coverage on a shift; drivers respond
-- yes/no. backlot.js reads them with an embedded join
-- (`extra_driver_requests` -> `extra_driver_responses`), which
-- PostgREST only resolves through a real foreign key — so the FK
-- below is load-bearing, not decorative.
--
-- The position column + CHECK are [EXACT]
-- (coverage-position-schema.sql).
-- ============================================================
create table if not exists public.extra_driver_requests (
  id           uuid primary key default gen_random_uuid(),
  manager_id   uuid references auth.users(id) on delete set null,
  shift_time   timestamptz not null,
  shifts       jsonb not null default '[]'::jsonb,
  needed_count integer not null default 1,
  note         text,
  status       text not null default 'open',     -- open | filled | cancelled
  position     text not null default 'driver',
  created_at   timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'extra_driver_requests_position_check'
  ) then
    alter table public.extra_driver_requests
      add constraint extra_driver_requests_position_check
      check (position in ('driver', 'detailer', 'cxr'));
  end if;
end$$;

create index if not exists extra_driver_requests_position_status_idx
  on public.extra_driver_requests (position, status);
create index if not exists extra_driver_requests_created_idx
  on public.extra_driver_requests (created_at desc);

alter table public.extra_driver_requests enable row level security;

drop policy if exists "extra_driver_requests_select_authenticated" on public.extra_driver_requests;
create policy "extra_driver_requests_select_authenticated"
  on public.extra_driver_requests for select to authenticated using (true);

drop policy if exists "extra_driver_requests_insert_privileged" on public.extra_driver_requests;
create policy "extra_driver_requests_insert_privileged"
  on public.extra_driver_requests for insert to authenticated
  with check (public.is_privileged());

drop policy if exists "extra_driver_requests_update_privileged" on public.extra_driver_requests;
create policy "extra_driver_requests_update_privileged"
  on public.extra_driver_requests for update to authenticated
  using (public.is_privileged()) with check (public.is_privileged());

drop policy if exists "extra_driver_requests_delete_privileged" on public.extra_driver_requests;
create policy "extra_driver_requests_delete_privileged"
  on public.extra_driver_requests for delete to authenticated
  using (public.is_privileged());


-- requests.js upserts on (request_id, driver_id), so that pair
-- needs a unique constraint for ON CONFLICT to resolve.
create table if not exists public.extra_driver_responses (
  id         uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.extra_driver_requests(id) on delete cascade,
  driver_id  uuid not null references auth.users(id) on delete cascade,
  response   text not null,                        -- yes | no
  shifts     jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists extra_driver_responses_unique_idx
  on public.extra_driver_responses (request_id, driver_id);

alter table public.extra_driver_responses enable row level security;

drop policy if exists "extra_driver_responses_select_authenticated" on public.extra_driver_responses;
create policy "extra_driver_responses_select_authenticated"
  on public.extra_driver_responses for select to authenticated using (true);

drop policy if exists "extra_driver_responses_upsert_own" on public.extra_driver_responses;
create policy "extra_driver_responses_upsert_own"
  on public.extra_driver_responses for insert to authenticated
  with check (driver_id = auth.uid());

drop policy if exists "extra_driver_responses_update_own" on public.extra_driver_responses;
create policy "extra_driver_responses_update_own"
  on public.extra_driver_responses for update to authenticated
  using (driver_id = auth.uid()) with check (driver_id = auth.uid());


-- ============================================================
-- COUNTER SNAPSHOTS                               [INFERRED]
--
-- End-of-shift tallies (Key Up / Garage / B-counter). app.js
-- inserts section, categories, total, notes, created_by and never
-- reads them back — the app has no snapshot history screen, so
-- this is a write-only audit trail. `categories` is an array of
-- { name, count }.
-- ============================================================
create table if not exists public.counter_snapshots (
  id         uuid primary key default gen_random_uuid(),
  section    text not null,
  categories jsonb not null default '[]'::jsonb,
  total      integer not null default 0,
  notes      text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists counter_snapshots_section_created_idx
  on public.counter_snapshots (section, created_at desc);

alter table public.counter_snapshots enable row level security;

drop policy if exists "counter_snapshots_select_authenticated" on public.counter_snapshots;
create policy "counter_snapshots_select_authenticated"
  on public.counter_snapshots for select to authenticated using (true);

drop policy if exists "counter_snapshots_insert_own" on public.counter_snapshots;
create policy "counter_snapshots_insert_own"
  on public.counter_snapshots for insert to authenticated
  with check (created_by = auth.uid());


-- ============================================================
-- FLEET COUNTS                                       [EXACT]
-- fleet-counts-schema.sql. Singleton row id = 'global'.
-- ============================================================
create table if not exists public.fleet_counts (
  id                text primary key default 'global',
  returns_count     integer not null default 0,
  rentals_count     integer not null default 0,
  note              text,
  returns_day_start integer,
  rentals_day_start integer,
  day_start_date    date,
  updated_at        timestamptz not null default now(),
  updated_by        uuid
);

insert into public.fleet_counts (id) values ('global') on conflict (id) do nothing;

alter table public.fleet_counts enable row level security;

drop policy if exists "fleet_counts_select_authenticated" on public.fleet_counts;
create policy "fleet_counts_select_authenticated"
  on public.fleet_counts for select to authenticated using (true);

drop policy if exists "fleet_counts_update_privileged" on public.fleet_counts;
create policy "fleet_counts_update_privileged"
  on public.fleet_counts for update to authenticated
  using (
    exists (select 1 from public.profiles p
             where p.id = auth.uid() and p.role in ('cxr','manager','admin'))
  )
  with check (
    exists (select 1 from public.profiles p
             where p.id = auth.uid() and p.role in ('cxr','manager','admin'))
  );

-- On the first update of a new ET day, freeze the OLD counts as the
-- day-start baseline so the banner can show today's drift.
create or replace function public.fn_fleet_counts_snapshot_day_start()
returns trigger
language plpgsql
as $$
declare
  today date := (now() at time zone 'America/New_York')::date;
begin
  if OLD.day_start_date is null or OLD.day_start_date <> today then
    NEW.returns_day_start := OLD.returns_count;
    NEW.rentals_day_start := OLD.rentals_count;
    NEW.day_start_date    := today;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_fleet_counts_day_start on public.fleet_counts;
create trigger trg_fleet_counts_day_start
  before update on public.fleet_counts
  for each row
  when (NEW.returns_count is distinct from OLD.returns_count
     or NEW.rentals_count is distinct from OLD.rentals_count)
  execute function public.fn_fleet_counts_snapshot_day_start();


-- ============================================================
-- PUSH SUBSCRIPTIONS                                 [EXACT]
-- push-schema.sql. One row per (user, device); endpoint is the PK
-- so re-subscribing on the same device overwrites.
-- ============================================================
create table if not exists public.push_subscriptions (
  endpoint    text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);
create index if not exists push_subscriptions_role_idx on public.push_subscriptions (role);

alter table public.push_subscriptions enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'push_subscriptions' and policyname = 'own subs insert') then
    create policy "own subs insert" on public.push_subscriptions
      for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'push_subscriptions' and policyname = 'own subs update') then
    create policy "own subs update" on public.push_subscriptions
      for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'push_subscriptions' and policyname = 'own subs delete') then
    create policy "own subs delete" on public.push_subscriptions
      for delete using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'push_subscriptions' and policyname = 'own subs select') then
    create policy "own subs select" on public.push_subscriptions
      for select using (auth.uid() = user_id);
  end if;
end$$;


-- ============================================================
-- STORAGE BUCKETS
--
-- vehicle-photos  [INFERRED] — private; record photos are read via
--   signed URLs (DT_MEDIA.signPhotoPaths). Only the privileged
--   policies are tracked (records-write-access-schema.sql); the
--   owner policies it refers to as "existing" were never in the
--   repo and are reconstructed here.
-- profile-avatars [EXACT] — public, per-user folder
--   (profile-avatar-schema.sql).
-- ============================================================
insert into storage.buckets (id, name, public)
values ('vehicle-photos', 'vehicle-photos', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('profile-avatars', 'profile-avatars', true)
on conflict (id) do update set public = true;

-- ----- vehicle-photos -----
drop policy if exists "vehicle_photos_own_write"  on storage.objects;
create policy "vehicle_photos_own_write"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'vehicle-photos' and owner = auth.uid());

drop policy if exists "vehicle_photos_read" on storage.objects;
create policy "vehicle_photos_read"
  on storage.objects for select to authenticated
  using (bucket_id = 'vehicle-photos');

-- [EXACT] — records-write-access-schema.sql
drop policy if exists "vehicle_photos_priv_write" on storage.objects;
create policy "vehicle_photos_priv_write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'vehicle-photos' and public.is_privileged());

drop policy if exists "vehicle_photos_priv_update" on storage.objects;
create policy "vehicle_photos_priv_update" on storage.objects
  for update to authenticated
  using (bucket_id = 'vehicle-photos' and public.is_privileged());

drop policy if exists "vehicle_photos_priv_read" on storage.objects;
create policy "vehicle_photos_priv_read" on storage.objects
  for select to authenticated
  using (bucket_id = 'vehicle-photos' and public.is_privileged());

-- ----- profile-avatars [EXACT] -----
drop policy if exists "avatars read"       on storage.objects;
drop policy if exists "avatars own write"  on storage.objects;
drop policy if exists "avatars own update" on storage.objects;
drop policy if exists "avatars own delete" on storage.objects;

create policy "avatars read"
  on storage.objects for select
  using (bucket_id = 'profile-avatars');

create policy "avatars own write"
  on storage.objects for insert
  with check (
    bucket_id = 'profile-avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "avatars own update"
  on storage.objects for update
  using (
    bucket_id = 'profile-avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "avatars own delete"
  on storage.objects for delete
  using (
    bucket_id = 'profile-avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );


-- ============================================================
-- REALTIME
--
-- Every table the app opens a postgres_changes channel on. Without
-- membership here those subscriptions connect and then sit silent.
-- ALTER PUBLICATION ... ADD TABLE errors if the table is already a
-- member, so each is checked first.
-- ============================================================
do $$
declare
  t text;
begin
  foreach t in array array[
    'records', 'profiles', 'detail_jobs', 'fleet_counts',
    'parking_sections', 'service_vendors', 'announcements',
    'announcement_replies', 'announcement_reactions',
    'extra_driver_requests', 'extra_driver_responses'
  ]
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;


-- ============================================================
-- SEED — historical Location dropdown codes as name-only rows, so
-- a fresh install has something in the dropdown before any
-- polygons are drawn. Idempotent via the case-insensitive index.
-- ============================================================
insert into public.parking_sections (name, status) values
  ('QTA',       'open'),
  ('BACKLOT',   'open'),
  ('GARAGE',    'open'),
  ('READY',     'open'),
  ('OVERFLOW',  'open'),
  ('BRANCH',    'open')
on conflict do nothing;

-- Let PostgREST pick up everything created above.
notify pgrst, 'reload schema';
