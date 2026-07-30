-- Persist each user's exact IANA timezone (from their browser on login/session).
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS timezone TEXT;

COMMENT ON COLUMN public.users.timezone IS
  'IANA timezone from the user''s device (e.g. America/New_York), refreshed on login/session.';
