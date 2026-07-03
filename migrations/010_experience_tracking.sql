-- Database Migration: Experience Tracking Tables
-- Targets: public.experiences, public.experience_sessions

-- Clean up any existing conflicting tables first
DROP TABLE IF EXISTS public.experience_sessions CASCADE;
DROP TABLE IF EXISTS public.experiences CASCADE;

-- =============================================
-- EXPERIENCES TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS public.experiences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('Volunteering', 'Research', 'Shadowing', 'Dental Experience', 'Employment', 'Academic')),
  title TEXT NOT NULL,
  organization TEXT NOT NULL,
  supervisor_name TEXT,
  supervisor_contact TEXT,
  description TEXT,
  start_date DATE NOT NULL,
  end_date DATE,
  is_ongoing BOOLEAN DEFAULT FALSE,
  dentist_type TEXT CHECK (dentist_type IN ('General', 'Specialty')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

-- =============================================
-- EXPERIENCE SESSIONS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS public.experience_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experience_id UUID NOT NULL REFERENCES public.experiences(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  duration NUMERIC(5, 2) NOT NULL, -- support decimal hours like 1.5, 3.75, etc.
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

-- =============================================
-- INDEXES & PERFORMANCE
-- =============================================
CREATE INDEX IF NOT EXISTS idx_experiences_student_id ON public.experiences(student_id);
CREATE INDEX IF NOT EXISTS idx_experiences_category ON public.experiences(category);
CREATE INDEX IF NOT EXISTS idx_experience_sessions_experience_id ON public.experience_sessions(experience_id);
CREATE INDEX IF NOT EXISTS idx_experience_sessions_date ON public.experience_sessions(date);

-- =============================================
-- ROW LEVEL SECURITY (RLS)
-- =============================================
ALTER TABLE public.experiences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.experience_sessions ENABLE ROW LEVEL SECURITY;

-- Triggers for updated_at
CREATE TRIGGER update_experiences_updated_at BEFORE UPDATE ON public.experiences
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_experience_sessions_updated_at BEFORE UPDATE ON public.experience_sessions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================
-- RLS POLICIES: EXPERIENCES
-- =============================================

CREATE POLICY "Users can view own experiences" ON public.experiences
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

CREATE POLICY "Users can insert own experiences" ON public.experiences
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

CREATE POLICY "Users can update own experiences" ON public.experiences
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

CREATE POLICY "Users can delete own experiences" ON public.experiences
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

-- =============================================
-- RLS POLICIES: SESSIONS
-- =============================================

CREATE POLICY "Users can view own experience sessions" ON public.experience_sessions
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.experiences e
      WHERE e.id = experience_id AND (
        e.student_id = auth.uid() OR
        EXISTS (
          SELECT 1 FROM public.student_profiles sp
          WHERE sp.id = e.student_id AND sp.mentor_id = auth.uid()
        ) OR
        EXISTS (
          SELECT 1 FROM public.users u
          WHERE u.id = auth.uid() AND u.role IN ('ADMIN', 'MENTOR_MANAGER')
        )
      )
    )
  );

CREATE POLICY "Users can manage own experience sessions" ON public.experience_sessions
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.experiences e
      WHERE e.id = experience_id AND (
        e.student_id = auth.uid() OR
        EXISTS (
          SELECT 1 FROM public.student_profiles sp
          WHERE sp.id = e.student_id AND sp.mentor_id = auth.uid()
        ) OR
        EXISTS (
          SELECT 1 FROM public.users u
          WHERE u.id = auth.uid() AND u.role IN ('ADMIN', 'MENTOR_MANAGER')
        )
      )
    )
  );

-- Enable Supabase Realtime for these tables
ALTER PUBLICATION supabase_realtime ADD TABLE public.experiences;
ALTER PUBLICATION supabase_realtime ADD TABLE public.experience_sessions;
