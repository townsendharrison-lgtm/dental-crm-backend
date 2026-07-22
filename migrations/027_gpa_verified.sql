-- GPA verification flag (staff-only), parallel to dat_verified
ALTER TABLE public.student_profiles
  ADD COLUMN IF NOT EXISTS gpa_verified BOOLEAN NOT NULL DEFAULT FALSE;
