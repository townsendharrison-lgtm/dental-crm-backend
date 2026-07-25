-- Licenses & Achievements for Profile & Docs
CREATE TABLE IF NOT EXISTS public.student_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('LICENSE', 'ACHIEVEMENT')),
  title TEXT NOT NULL,
  issuer TEXT NOT NULL DEFAULT '',
  year TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT TIMEZONE('utc', NOW()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT TIMEZONE('utc', NOW())
);

CREATE INDEX IF NOT EXISTS idx_student_credentials_student_id
  ON public.student_credentials(student_id);
CREATE INDEX IF NOT EXISTS idx_student_credentials_kind
  ON public.student_credentials(student_id, kind);

ALTER TABLE public.student_credentials ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS update_student_credentials_updated_at ON public.student_credentials;
CREATE TRIGGER update_student_credentials_updated_at
  BEFORE UPDATE ON public.student_credentials
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Allow experiences without organization (category + title + start date only required)
ALTER TABLE public.experiences
  ALTER COLUMN organization SET DEFAULT '';

ALTER TABLE public.experiences
  ALTER COLUMN organization DROP NOT NULL;

-- Dexterity: start_date optional (UI no longer collects it)
ALTER TABLE public.student_dexterity
  ALTER COLUMN start_date DROP NOT NULL;
