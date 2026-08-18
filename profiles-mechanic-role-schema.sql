-- ============================================================
-- Profiles: allow the 'mechanic' role
--
-- The `profiles.role` column carries a CHECK constraint (created
-- outside this repo's tracked schema files, back when the driver/
-- cxr/manager/admin/detailer roles were first added) that doesn't
-- know about 'mechanic' yet. Without this, setting a profile's role
-- to 'mechanic' fails with:
--   new row for relation "profiles" violates check constraint "profiles_role_check"
--
-- Run this once in the Supabase SQL editor before assigning anyone
-- the mechanic role.
-- ============================================================

alter table public.profiles
  drop constraint if exists profiles_role_check;

alter table public.profiles
  add constraint profiles_role_check
  check (role in ('driver', 'cxr', 'detailer', 'mechanic', 'manager', 'admin'));
