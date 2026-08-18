-- ============================================================
-- service_vendors: split address into city / state / zip
--
-- `address` stays the street line; these three carry the rest so the
-- vendor form and any future "vendors near me" / mailing-label use
-- don't have to parse a single freeform string.
--
-- Idempotent. Run in the Supabase SQL editor.
-- ============================================================

alter table public.service_vendors
  add column if not exists city  text,
  add column if not exists state text,
  add column if not exists zip   text;
