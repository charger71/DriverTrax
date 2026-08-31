-- ============================================================
-- sipp_codes: "Luxury" flag
--
-- Luxury classes (LCAR, LDAR, ...) route differently than the mileage-only
-- Executive/Emerald/Enterprise-Alamo tiers: per the Training panel's
-- "Luxuries" note, they go to Premiere spots at ~20,000 miles or under,
-- otherwise the WALL or Enterprise/Alamo. Rather than hardcoding a fixed
-- list of "luxury" codes, managers flag which ones count from Backlot's
-- SIPP Codes admin (backlot/sipp-codes.js) — mirrors how the codes
-- themselves are already editable there instead of hardcoded.
--
-- Idempotent. Run in the Supabase SQL editor.
-- ============================================================

alter table public.sipp_codes
  add column if not exists is_luxury boolean not null default false;

comment on column public.sipp_codes.is_luxury is
  'True routes this class to Premiere (<=20k mi) or Wall/Enterprise-Alamo (>20k mi) in the driver app''s entry-form routing hint, instead of the standard Executive/Emerald/Enterprise-Alamo mileage tiers. Set from Backlot''s SIPP Codes admin.';

-- One-time default so the two codes already labeled "Luxury" / "Luxury
-- (4-door)" come up flagged out of the box. Purely a starting point —
-- the checkbox in Backlot is the source of truth from here on, so re-running
-- this after a manager has changed either row will stomp their edit.
update public.sipp_codes set is_luxury = true where code in ('LCAR', 'LDAR');
