-- ============================================================
-- service_jobs: "last touched by" attribution
--
-- service_jobs already tracked opened_by (who started the job), but
-- nothing recorded who most recently acted on it (saved, sent out,
-- marked returned, toggled waiting-on-parts, or closed). With jobs now
-- visible shop-wide on the mechanic landing screen, a mechanic picking
-- up a job needs to see who touched it last, not just who opened it.
--
-- Set client-side from maintenance.js on every insert/update (same
-- pattern as fleet_counts.updated_by in fleet-counts-schema.sql), not
-- via a trigger — keeps it consistent with the rest of this table's
-- app-driven writes.
--
-- Idempotent. Run in the Supabase SQL editor.
-- ============================================================

alter table public.service_jobs
  add column if not exists updated_by uuid;
