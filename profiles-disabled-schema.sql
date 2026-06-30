-- ============================================================
-- Profiles: disabled flag
-- Run this once in the Supabase SQL editor.
--
-- Adds:
--   * disabled — true when a manager/admin has disabled the account.
--                The admin-users edge function also bans the auth user
--                (sets auth.users.banned_until) so sign-in is blocked.
--                This column lets the UI render a "Disabled" state without
--                a separate auth.users lookup.
-- ============================================================

alter table public.profiles
  add column if not exists disabled boolean not null default false;

create index if not exists profiles_disabled_idx
  on public.profiles (disabled)
  where disabled = true;
