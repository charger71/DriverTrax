-- ============================================================
-- DriverTrax coverage requests — position column
--
-- Adds a `position` column to extra_driver_requests so a coverage
-- request can target driver, detailer, or CXR roles. Existing rows
-- (originally driver-only) default to 'driver'.
--
-- Run in the Supabase SQL editor. Idempotent.
-- ============================================================

alter table public.extra_driver_requests
  add column if not exists position text not null default 'driver';

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
