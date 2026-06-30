-- ============================================================
-- Profiles: phone + approval gate
-- Run this once in the Supabase SQL editor.
--
-- Adds:
--   * phone     — E.164 contact number (mirrors auth.users.phone for
--                 users invited by SMS; otherwise free-form contact).
--   * approved  — gate for self-signed-up accounts. Invited users are
--                 pre-approved by the inviter; public signups land
--                 with approved=false until a manager confirms them.
-- ============================================================

alter table public.profiles
  add column if not exists phone    text,
  add column if not exists approved boolean not null default false;

-- Backfill: everyone already in the system is approved.
update public.profiles set approved = true where approved = false;

-- Index for the "pending approval" list managers will scan.
create index if not exists profiles_approved_idx
  on public.profiles (approved)
  where approved = false;

-- Let managers/admins/cxrs flip approved + phone via the normal
-- profiles update RLS policy. No new policy needed if your existing
-- policy already allows manager-tier updates on profiles.
