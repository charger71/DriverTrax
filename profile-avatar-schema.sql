-- Avatar / headshot support on profiles.
-- Stores a public URL pointing at the profile-avatars bucket.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS avatar_url text;

-- Create a public storage bucket for profile avatars. Public so the contact
-- card can render the image with a plain <img src> (no signing round-trip).
INSERT INTO storage.buckets (id, name, public)
VALUES ('profile-avatars', 'profile-avatars', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- RLS: a user may upload / overwrite / delete their own avatar; everyone can
-- read (bucket is public anyway).
DROP POLICY IF EXISTS "avatars own write"  ON storage.objects;
DROP POLICY IF EXISTS "avatars own update" ON storage.objects;
DROP POLICY IF EXISTS "avatars own delete" ON storage.objects;
DROP POLICY IF EXISTS "avatars read"       ON storage.objects;

CREATE POLICY "avatars read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'profile-avatars');

CREATE POLICY "avatars own write"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'profile-avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "avatars own update"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'profile-avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "avatars own delete"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'profile-avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
