-- Application roadmap milestones + month colors on student profiles

ALTER TABLE public.student_profiles
  ADD COLUMN IF NOT EXISTS month_colors JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS public.student_milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  month TEXT NOT NULL, -- YYYY-MM
  status TEXT NOT NULL DEFAULT 'Planned' CHECK (status IN ('Planned', 'Completed')),
  is_custom BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_student_milestones_student_id ON public.student_milestones(student_id);
CREATE INDEX IF NOT EXISTS idx_student_milestones_month ON public.student_milestones(student_id, month);

ALTER TABLE public.student_milestones ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS update_student_milestones_updated_at ON public.student_milestones;
CREATE TRIGGER update_student_milestones_updated_at BEFORE UPDATE ON public.student_milestones
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE POLICY "Users can view own milestones" ON public.student_milestones
  FOR SELECT USING (
    auth.uid() = student_id OR
    EXISTS (
      SELECT 1 FROM public.student_profiles sp
      WHERE sp.id = student_id AND sp.mentor_id = auth.uid()
    ) OR
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND u.role IN ('ADMIN', 'MENTOR_MANAGER')
    )
  );

CREATE POLICY "Users can insert own milestones" ON public.student_milestones
  FOR INSERT WITH CHECK (
    auth.uid() = student_id OR
    EXISTS (
      SELECT 1 FROM public.student_profiles sp
      WHERE sp.id = student_id AND sp.mentor_id = auth.uid()
    ) OR
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND u.role IN ('ADMIN', 'MENTOR_MANAGER')
    )
  );

CREATE POLICY "Users can update own milestones" ON public.student_milestones
  FOR UPDATE USING (
    auth.uid() = student_id OR
    EXISTS (
      SELECT 1 FROM public.student_profiles sp
      WHERE sp.id = student_id AND sp.mentor_id = auth.uid()
    ) OR
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND u.role IN ('ADMIN', 'MENTOR_MANAGER')
    )
  );

CREATE POLICY "Users can delete own milestones" ON public.student_milestones
  FOR DELETE USING (
    auth.uid() = student_id OR
    EXISTS (
      SELECT 1 FROM public.student_profiles sp
      WHERE sp.id = student_id AND sp.mentor_id = auth.uid()
    ) OR
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND u.role IN ('ADMIN', 'MENTOR_MANAGER')
    )
  );
