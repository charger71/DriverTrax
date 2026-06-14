-- ============================================================
-- DriverTrax fleet_counts — singleton row holding lot-wide
-- counts that managers / CXRs broadcast to drivers.
--
-- Run in the Supabase SQL editor. Idempotent.
-- ============================================================

create table if not exists public.fleet_counts (
  id            text primary key default 'global',
  returns_count integer not null default 0,
  rentals_count integer not null default 0,
  note          text,
  updated_at    timestamptz not null default now(),
  updated_by    uuid
);

-- Day-start snapshots — set on the first update of each new day so
-- managers can see how the numbers have shifted since opening.
alter table public.fleet_counts
  add column if not exists returns_day_start integer,
  add column if not exists rentals_day_start integer,
  add column if not exists day_start_date    date;

-- Seed the singleton row so the banner always has something to read.
insert into public.fleet_counts (id) values ('global')
  on conflict (id) do nothing;

alter table public.fleet_counts enable row level security;

-- Everyone signed-in can read the banner.
drop policy if exists "fleet_counts_select_authenticated" on public.fleet_counts;
create policy "fleet_counts_select_authenticated"
  on public.fleet_counts for select
  to authenticated
  using (true);

-- CXR / manager / admin can update. Role lives on the profiles table.
drop policy if exists "fleet_counts_update_privileged" on public.fleet_counts;
create policy "fleet_counts_update_privileged"
  on public.fleet_counts for update
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role in ('cxr','manager','admin')
    )
  )
  with check (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role in ('cxr','manager','admin')
    )
  );

-- ----- Day-start snapshot trigger -----
-- On the first update of a new day, freeze the OLD counts as the
-- day-start baseline so the banner can show today's drift alongside
-- the live numbers. Subsequent updates the same day leave the
-- baseline alone.
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

-- Make sure realtime broadcasts changes. Idempotent — `ALTER PUBLICATION
-- ... ADD TABLE` errors if the table is already a member, so check first.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'fleet_counts'
  ) then
    execute 'alter publication supabase_realtime add table public.fleet_counts';
  end if;
end $$;
