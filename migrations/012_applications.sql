-- Database Migration: Applications Tracking Table
-- Targets: public.applications

-- Clean up any existing conflicting tables first
DROP TABLE IF EXISTS public.applications CASCADE;

-- =============================================
-- APPLICATIONS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS public.applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  school_id TEXT NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('Interested', 'Applying', 'Applied', 'Interviewed', 'Accepted', 'Waitlisted', 'Rejected')) DEFAULT 'Applied',
  applied_date DATE,
  interview_date DATE,
  decision_date DATE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  UNIQUE(student_id, school_id) -- A student can only track one application record per school
);

-- =============================================
-- INDEXES & PERFORMANCE
-- =============================================
CREATE INDEX IF NOT EXISTS idx_applications_student_id ON public.applications(student_id);
CREATE INDEX IF NOT EXISTS idx_applications_school_id ON public.applications(school_id);
CREATE INDEX IF NOT EXISTS idx_applications_status ON public.applications(status);

-- =============================================
-- ROW LEVEL SECURITY (RLS)
-- =============================================
ALTER TABLE public.applications ENABLE ROW LEVEL SECURITY;

-- Trigger for updated_at
CREATE TRIGGER update_applications_updated_at BEFORE UPDATE ON public.applications
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================
-- RLS POLICIES
-- =============================================

CREATE POLICY "Users can view own applications" ON public.applications
  FOR SELECT USING (
    auth.uid() = student_id OR
    EXISTS (
      SELECT 1 FROM public.student_profiles sp
      WHERE sp.id = student_id AND sp.mentor_id = auth.uid()
    ) OR
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND role IN ('ADMIN', 'MENTOR_MANAGER')
    )
  );

CREATE POLICY "Students can insert own applications" ON public.applications
  FOR INSERT WITH CHECK (
    auth.uid() = student_id OR
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND role = 'ADMIN'
    )
  );

CREATE POLICY "Users can update own applications" ON public.applications
  FOR UPDATE USING (
    auth.uid() = student_id OR
    EXISTS (
      SELECT 1 FROM public.student_profiles sp
      WHERE sp.id = student_id AND sp.mentor_id = auth.uid()
    ) OR
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND role IN ('ADMIN', 'MENTOR_MANAGER')
    )
  );

CREATE POLICY "Users can delete own applications" ON public.applications
  FOR DELETE USING (
    auth.uid() = student_id OR
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND role = 'ADMIN'
    )
  );

-- Enable Supabase Realtime for this table
ALTER PUBLICATION supabase_realtime ADD TABLE public.applications;
