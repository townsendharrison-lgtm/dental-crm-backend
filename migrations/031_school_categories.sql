-- Persist custom school-list categories on student profiles

ALTER TABLE public.student_profiles
  ADD COLUMN IF NOT EXISTS school_categories JSONB DEFAULT NULL;
