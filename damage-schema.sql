-- ============================================================
-- DriverTrax vehicle damage + tire + insurance-claim schema
--
-- Three tables, all keyed by serial_id (same key the records table uses):
--   vehicle_damage — append-only damage marks
--   vehicle_tires  — upserted current tire state (one row per position)
--   vehicle_claims — upserted current insurance claim (one row per vehicle)
--
-- Auth model:
--   read/insert  → any authenticated user
--   update       → any authenticated user (upsert) EXCEPT vehicle_damage,
--                  which is manager/admin only
--   delete       → manager or admin only on all three tables
--
-- Fully idempotent: safe to re-run. Every `create policy` is preceded by
-- `drop policy if exists`, and the realtime publication registrations are
-- wrapped in DO blocks that swallow the "already added" error.
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

drop policy if exists "vd_read"       on public.vehicle_damage;
drop policy if exists "vd_insert"     on public.vehicle_damage;
drop policy if exists "vd_update_mgr" on public.vehicle_damage;
drop policy if exists "vd_delete_mgr" on public.vehicle_damage;

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

drop policy if exists "vt_read"       on public.vehicle_tires;
drop policy if exists "vt_insert"     on public.vehicle_tires;
drop policy if exists "vt_update_any" on public.vehicle_tires;
drop policy if exists "vt_delete_mgr" on public.vehicle_tires;

create policy "vt_read" on public.vehicle_tires
  for select to authenticated using (true);

create policy "vt_insert" on public.vehicle_tires
  for insert to authenticated with check (updated_by = auth.uid());

-- Anyone authenticated can update an existing tire row (line CXR needs
-- to flip Worn -> Replace without a manager present). The with-check
-- ensures they stamp themselves as the updater.
create policy "vt_update_any" on public.vehicle_tires
  for update to authenticated
  using (true)
  with check (updated_by = auth.uid());

create policy "vt_delete_mgr" on public.vehicle_tires
  for delete to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('manager','admin'))
  );

-- ---------- vehicle_claims: one upserted row per vehicle ----------
-- Populated when the CXR types an insurance claim # in the damage modal.
-- The `notes` field only surfaces in the UI once a claim # is present.
create table if not exists public.vehicle_claims (
  serial_id     text        primary key,
  claim_number  text,
  notes         text,
  updated_by    uuid        references auth.users(id) on delete set null,
  updated_at    timestamptz not null default now()
);

alter table public.vehicle_claims enable row level security;

drop policy if exists "vc_read"       on public.vehicle_claims;
drop policy if exists "vc_insert"     on public.vehicle_claims;
drop policy if exists "vc_update_any" on public.vehicle_claims;
drop policy if exists "vc_delete_mgr" on public.vehicle_claims;

create policy "vc_read" on public.vehicle_claims
  for select to authenticated using (true);

create policy "vc_insert" on public.vehicle_claims
  for insert to authenticated with check (updated_by = auth.uid());

-- Any authenticated user can edit an existing claim (line CXR can add
-- notes without a manager). Delete is manager/admin only.
create policy "vc_update_any" on public.vehicle_claims
  for update to authenticated
  using (true)
  with check (updated_by = auth.uid());

create policy "vc_delete_mgr" on public.vehicle_claims
  for delete to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('manager','admin'))
  );

-- ---------- realtime ----------
-- Add each table to the supabase_realtime publication, ignoring the
-- "relation is already member" error (SQLSTATE 42710) so re-runs succeed.
do $$
begin
  begin alter publication supabase_realtime add table public.vehicle_damage;
  exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.vehicle_tires;
  exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.vehicle_claims;
  exception when duplicate_object then null; end;
end $$;
