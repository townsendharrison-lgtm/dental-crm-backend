-- Application Journey phase completion (mentor-checked)

ALTER TABLE public.student_profiles
  ADD COLUMN IF NOT EXISTS application_journey JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.student_profiles.application_journey IS
  'Application Journey phase completion: phase1–phase4 booleans (mentor/staff editable)';
