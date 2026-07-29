-- External school-selection customers (no auth.users / no CRM student accounts).
-- Plans for walk-in / off-platform customers use external_id + school_board JSON.

CREATE TABLE IF NOT EXISTS public.school_selection_externals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_school_selection_externals_created_by
  ON public.school_selection_externals(created_by);

-- Allow plans without a CRM student (external customers instead)
ALTER TABLE public.optimization_plans
  ALTER COLUMN student_id DROP NOT NULL;

-- PostgreSQL UNIQUE allows multiple NULLs, so existing unique(student_id) still works

ALTER TABLE public.optimization_plans
  ADD COLUMN IF NOT EXISTS external_id UUID UNIQUE
    REFERENCES public.school_selection_externals(id) ON DELETE CASCADE;

ALTER TABLE public.optimization_plans
  ADD COLUMN IF NOT EXISTS school_board JSONB DEFAULT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'optimization_plans_subject_check'
  ) THEN
    ALTER TABLE public.optimization_plans
      ADD CONSTRAINT optimization_plans_subject_check
      CHECK (
        (student_id IS NOT NULL AND external_id IS NULL)
        OR
        (student_id IS NULL AND external_id IS NOT NULL)
      );
  END IF;
END $$;

COMMENT ON TABLE public.school_selection_externals IS
  'Off-platform customers for Strategic School Selection reports — not CRM students.';
COMMENT ON COLUMN public.optimization_plans.external_id IS
  'Set for external (non-account) plans instead of student_id.';
COMMENT ON COLUMN public.optimization_plans.school_board IS
  'Categories + schools snapshot for external plans (JSONB).';
