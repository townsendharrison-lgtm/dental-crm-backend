-- Admin-authored first-login guides for students and mentors,
-- plus a per-user timestamp once they finish the guide.

ALTER TABLE public.admin_settings
  ADD COLUMN IF NOT EXISTS student_onboarding JSONB,
  ADD COLUMN IF NOT EXISTS mentor_onboarding JSONB;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;
