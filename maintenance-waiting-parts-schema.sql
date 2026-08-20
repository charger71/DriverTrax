-- ============================================================
-- service_jobs: "Waiting on Parts" flag
--
-- A mechanic can mark an OPEN (or RETURNED-from-vendor) job as blocked
-- on a part without closing it or sending it to a vendor — a state
-- that didn't exist before. Modeled as a flag alongside `state` rather
-- than a fifth `state` value: a job can be waiting on parts whether
-- it's in-house (OPEN) or a returned vendor job still needs a part
-- before it can close, so cross-producing that into the state enum
-- would double the state machine for no benefit.
--
-- Paired with two new DERIVED statuses on the driver-app side
-- (AT_VENDOR, WAITING_PARTS — see DT_OPTIONS.STATUS_DERIVED in app.js)
-- so the vehicle's current_status and the records log show *why* a car
-- hasn't moved, not just the mechanic's own screen.
--
-- Idempotent. Run in the Supabase SQL editor.
-- ============================================================

alter table public.service_jobs
  add column if not exists waiting_on_parts boolean not null default false,
  add column if not exists parts_note        text,
  add column if not exists waiting_since     timestamptz;

create index if not exists service_jobs_waiting_idx
  on public.service_jobs (waiting_on_parts)
  where waiting_on_parts = true;
