-- Theme preference per user. Allowed values: 'system' | 'dark' | 'light'.
-- NULL means "no cloud preference yet" — the client falls back to the local
-- localStorage value, then to 'system'.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS theme_preference text
  CHECK (theme_preference IN ('system', 'dark', 'light'));
