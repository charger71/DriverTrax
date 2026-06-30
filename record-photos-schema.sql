-- Multi-photo support on records.
-- Existing single-photo column (photo_url) is preserved for back-compat reads;
-- new entries write to photo_urls (JSONB array of storage paths).

ALTER TABLE records
  ADD COLUMN IF NOT EXISTS photo_urls jsonb;

-- Backfill: copy any existing single photo_url into the array so reads can
-- consume one shape going forward.
UPDATE records
   SET photo_urls = jsonb_build_array(photo_url)
 WHERE photo_url IS NOT NULL
   AND photo_url <> ''
   AND photo_urls IS NULL;
