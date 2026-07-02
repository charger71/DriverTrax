-- ============================================================
-- DriverTrax vehicle damage + tire inspection schema
--
-- Two tables, both keyed by serial_id (the vehicle tag/serial, same key
-- the records table uses). Damage marks are append-only; tire status is
-- upserted so there is exactly one row per (serial_id, position).
--
-- Auth model:
--   read/insert  → any authenticated user
--   update/delete on vehicle_damage → manager or admin only
--   update       on vehicle_tires   → any authenticated user (upsert)
--   delete       on vehicle_tires   → manager or admin only
-- ============================================================

-- ---------- vehicle_damage: one row per damage mark ----------
create table if not exists public.vehicle_damage (
  id           uuid        primary key default gen_random_uuid(),
  serial_id    text        not null,
  panel_id     text        not null,
  damage_type  text        not null check (damage_type in ('dent','scratch','chip','crack','missing')),
  notes        text,
  -- SVG userspace coords in the diagram's 300 x 400 viewBox
  x            real        not null,
  y            real        not null,
  created_by   uuid        references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists vehicle_damage_serial_idx  on public.vehicle_damage(serial_id);
create index if not exists vehicle_damage_created_idx on public.vehicle_damage(created_at desc);

alter table public.vehicle_damage enable row level security;

create policy "vd_read" on public.vehicle_damage
  for select to authenticated using (true);

create policy "vd_insert" on public.vehicle_damage
  for insert to authenticated with check (created_by = auth.uid());

create policy "vd_update_mgr" on public.vehicle_damage
  for update to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('manager','admin'))
  );

create policy "vd_delete_mgr" on public.vehicle_damage
  for delete to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('manager','admin'))
  );

-- ---------- vehicle_tires: one row per (serial_id, position) ----------
create table if not exists public.vehicle_tires (
  serial_id    text        not null,
  position     text        not null check (position in ('FL','FR','RL','RR')),
  condition    text        check (condition in ('OK','worn','low','flat','replace')),
  psi          integer     check (psi is null or (psi between 0 and 200)),
  notes        text,
  updated_by   uuid        references auth.users(id) on delete set null,
  updated_at   timestamptz not null default now(),
  primary key (serial_id, position)
);

create index if not exists vehicle_tires_serial_idx on public.vehicle_tires(serial_id);

alter table public.vehicle_tires enable row level security;

create policy "vt_read" on public.vehicle_tires
  for select to authenticated using (true);

create policy "vt_insert" on public.vehicle_tires
  for insert to authenticated with check (updated_by = auth.uid());

-- Anyone authenticated can update an existing tire row (line CXR needs to
-- flip a tire from Worn -> Replace without a manager present). The
-- with-check ensures they stamp themselves as the updater.
create policy "vt_update_any" on public.vehicle_tires
  for update to authenticated
  using (true)
  with check (updated_by = auth.uid());

create policy "vt_delete_mgr" on public.vehicle_tires
  for delete to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('manager','admin'))
  );

-- ---------- realtime ----------
-- Enable Supabase realtime so damage.js can react to remote changes on
-- the currently-open vehicle.
alter publication supabase_realtime add table public.vehicle_damage;
alter publication supabase_realtime add table public.vehicle_tires;
