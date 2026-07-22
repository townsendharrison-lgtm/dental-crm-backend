-- Allow Strong Fit + custom school-list categories; add notes on applications

ALTER TABLE public.student_schools
  DROP CONSTRAINT IF EXISTS student_schools_category_check;

ALTER TABLE public.student_schools
  ADD CONSTRAINT student_schools_category_check
  CHECK (char_length(trim(category)) > 0 AND char_length(category) <= 100);

ALTER TABLE public.applications
  ADD COLUMN IF NOT EXISTS notes TEXT;
