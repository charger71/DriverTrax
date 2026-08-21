-- ============================================================
-- service_jobs: multi-entry notes log + "what's being done" picker
--
-- notes_log — append-only jsonb array of { note, ts, author } so a
-- mechanic can log an update any time they touch the car (not just at
-- open/send/return/close) without clobbering earlier notes the way the
-- old single `notes` text column did. `notes` itself is left in place
-- and kept in sync with the latest log entry for any existing reader
-- that only knows about the single-value column.
--
-- service_actions / service_action_other — structured alternative to
-- freeform "what's being done" text: a short pick list (Oil Change,
-- Rotate Tires, ...) plus an Other value for a specialty issue.
-- Mirrors the existing value/value_other pairing used elsewhere in this
-- schema (e.g. vehicles.current_status / current_status_other).
--
-- Idempotent. Run in the Supabase SQL editor.
-- ============================================================

alter table public.service_jobs
  add column if not exists notes_log            jsonb not null default '[]'::jsonb,
  add column if not exists service_actions      jsonb not null default '[]'::jsonb,
  add column if not exists service_action_other text;
