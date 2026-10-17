-- Per-step onboarding progress for students.
-- Safe to run after 063_onboarding.sql.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS onboarding_step_ids TEXT[] DEFAULT '{}';
