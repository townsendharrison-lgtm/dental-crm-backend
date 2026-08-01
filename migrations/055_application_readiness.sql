-- Application Readiness checklist (manual flags) + Extracurricular experience category

ALTER TABLE public.student_profiles
  ADD COLUMN IF NOT EXISTS application_readiness JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.student_profiles.application_readiness IS
  'Manual Application Readiness flags: dat_scheduled, dat_completed, personal_statement_written, experience_descriptions_written, school_list_finalized';

-- Allow Extracurricular Activities in Hour Tracker / DSG experiences
ALTER TABLE public.experiences DROP CONSTRAINT IF EXISTS experiences_category_check;
ALTER TABLE public.experiences
  ADD CONSTRAINT experiences_category_check
  CHECK (category IN (
    'Volunteering',
    'Research',
    'Shadowing',
    'Dental Experience',
    'Employment',
    'Academic',
    'Extracurricular'
  ));
