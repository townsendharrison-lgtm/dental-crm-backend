-- Dedicated table for per-student school-list categories
-- (Reach / Target / Strong Fit / custom columns)

CREATE TABLE IF NOT EXISTS public.student_school_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  category_key TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6366f1',
  icon TEXT NOT NULL DEFAULT 'SchoolIcon',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT TIMEZONE('utc', NOW()),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT TIMEZONE('utc', NOW()),
  UNIQUE (student_id, category_key)
);

CREATE INDEX IF NOT EXISTS idx_student_school_categories_student_id
  ON public.student_school_categories(student_id);

ALTER TABLE public.student_school_categories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view school categories" ON public.student_school_categories;
CREATE POLICY "Users can view school categories" ON public.student_school_categories
  FOR SELECT USING (
    auth.uid() = student_id
    OR EXISTS (
      SELECT 1 FROM public.student_profiles sp
      WHERE sp.id = student_school_categories.student_id
        AND sp.mentor_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND u.role IN ('ADMIN', 'MENTOR_MANAGER')
    )
  );

DROP POLICY IF EXISTS "Users can manage school categories" ON public.student_school_categories;
CREATE POLICY "Users can manage school categories" ON public.student_school_categories
  FOR ALL USING (
    auth.uid() = student_id
    OR EXISTS (
      SELECT 1 FROM public.student_profiles sp
      WHERE sp.id = student_school_categories.student_id
        AND sp.mentor_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND u.role IN ('ADMIN', 'MENTOR_MANAGER')
    )
  );

-- Keep JSONB column from 031 as optional legacy mirror (safe if already present)
ALTER TABLE public.student_profiles
  ADD COLUMN IF NOT EXISTS school_categories JSONB DEFAULT NULL;
