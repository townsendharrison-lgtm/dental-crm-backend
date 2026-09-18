-- Additive: link CRM schools to school-ai-service UUID schools.
-- Never deletes or truncates existing data.

ALTER TABLE public.schools
  ADD COLUMN IF NOT EXISTS ai_school_id UUID;

COMMENT ON COLUMN public.schools.ai_school_id IS
  'UUID of the matching school in school_ai.schools (Python school-ai-service).';

CREATE INDEX IF NOT EXISTS idx_schools_ai_school_id
  ON public.schools (ai_school_id)
  WHERE ai_school_id IS NOT NULL;
