-- ============================================================
-- sipp_codes: "Compact" flag + Compact SUV code
--
-- Executive only takes cars 10,000 miles or under AND not compact-class —
-- see the Training panel's Clean Car Notes ("No Trax, Sentra, Spark, etc.").
-- The driver app's routing hint originally hardcoded that exclusion to the
-- single code CCAR, which missed compact SUVs like the Chevy Trax (no SIPP
-- code even existed for that class). Both problems get the same fix as
-- sipp-codes-luxury-schema.sql's is_luxury: a manager-settable flag instead
-- of a hardcoded code, so any compact-class code (present or future) can be
-- excluded from Executive without another deploy.
--
-- Idempotent. Run in the Supabase SQL editor.
-- ============================================================

alter table public.sipp_codes
  add column if not exists is_compact boolean not null default false;

comment on column public.sipp_codes.is_compact is
  'True excludes this class from Executive in the driver app''s entry-form routing hint (mileageRouteDestination in app.js), regardless of mileage. Set from Backlot''s SIPP Codes admin.';

-- CFAR (Compact SUV — ACRISS: C=Compact size, F=SUV body) didn't exist in
-- the catalog at all, so a Trax had no correct code to be tagged with.
insert into public.sipp_codes (code, label) values
  ('CFAR', 'Compact SUV')
on conflict (code) do nothing;

-- One-time default so the codes already known to be compact-class come up
-- flagged out of the box. Purely a starting point — the checkbox in Backlot
-- is the source of truth from here on, so re-running this after a manager
-- has changed either row will stomp their edit.
update public.sipp_codes set is_compact = true where code in ('CCAR', 'CFAR');
