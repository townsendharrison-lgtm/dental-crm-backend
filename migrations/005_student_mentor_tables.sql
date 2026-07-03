-- Database Migration: Student and Mentor Management Tables
-- Targets: public.student_profiles, public.mentor_profiles, public.student_assignments

-- =============================================
-- STUDENT PROFILES TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS public.student_profiles (
  id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  mentor_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  readiness TEXT NOT NULL CHECK (readiness IN ('GREEN', 'YELLOW', 'RED')) DEFAULT 'YELLOW',
  last_meeting_date TIMESTAMP WITH TIME ZONE,
  next_meeting_date TIMESTAMP WITH TIME ZONE,
  last_contact_date TIMESTAMP WITH TIME ZONE,
  missing_docs_count INTEGER NOT NULL DEFAULT 0,
  open_action_items_count INTEGER NOT NULL DEFAULT 0,
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  zip_code TEXT,
  strength_score INTEGER NOT NULL DEFAULT 0 CHECK (strength_score >= 0 AND strength_score <= 100),
  gpa NUMERIC(3,2),
  avg_response_time NUMERIC NOT NULL DEFAULT 0, -- in hours
  dat_score INTEGER DEFAULT 0,
  dat_aa INTEGER DEFAULT 0,
  dat_ts INTEGER DEFAULT 0,
  is_reapplicant BOOLEAN NOT NULL DEFAULT FALSE,
  application_cycle TEXT,
  status TEXT NOT NULL CHECK (status IN ('Preparing', 'Applying', 'Interviewing')) DEFAULT 'Preparing',
  state TEXT,
  country TEXT,
  ethnicity TEXT,
  gender TEXT,
  age INTEGER,
  dat_verified BOOLEAN NOT NULL DEFAULT FALSE,
  undergrad_institution TEXT,
  undergrad_degree TEXT,
  undergrad_grad_year TEXT,
  post_bac JSONB DEFAULT NULL, -- Format: { enabled: boolean, institution: string, strengthScore: number, degreeType: string, year: string }
  masters JSONB DEFAULT NULL,   -- Format: { enabled: boolean, institution: string, strengthScore: number, degreeType: string, year: string }
  lor_required INTEGER NOT NULL DEFAULT 0,
  lor_external_service BOOLEAN NOT NULL DEFAULT FALSE,
  timezone TEXT,
  last_profile_reminder_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

-- =============================================
-- MENTOR PROFILES TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS public.mentor_profiles (
  id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  avg_response_time TEXT DEFAULT '4h',
  avg_response_time_value NUMERIC NOT NULL DEFAULT 0, -- in hours
  compliance_score INTEGER NOT NULL DEFAULT 100 CHECK (compliance_score >= 0 AND compliance_score <= 100),
  default_availability TEXT[] DEFAULT '{}',
  phone TEXT,
  school TEXT,
  graduation_year TEXT,
  notes TEXT,
  manager_score INTEGER NOT NULL DEFAULT 100 CHECK (manager_score >= 0 AND manager_score <= 100),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

-- =============================================
-- STUDENT ASSIGNMENTS TABLE (History Log)
-- =============================================
CREATE TABLE IF NOT EXISTS public.student_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  mentor_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'ACCEPTED', 'DECLINED', 'TRANSFERRED')) DEFAULT 'PENDING',
  assigned_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  accepted_at TIMESTAMP WITH TIME ZONE,
  transferred_at TIMESTAMP WITH TIME ZONE,
  available_times TEXT[] DEFAULT '{}',
  welcome_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

-- =============================================
-- INDEXES & PERFORMANCE
-- =============================================
CREATE INDEX IF NOT EXISTS idx_student_profiles_mentor_id ON public.student_profiles(mentor_id);
CREATE INDEX IF NOT EXISTS idx_student_assignments_student_id ON public.student_assignments(student_id);
CREATE INDEX IF NOT EXISTS idx_student_assignments_mentor_id ON public.student_assignments(mentor_id);

-- =============================================
-- ROW LEVEL SECURITY (RLS)
-- =============================================
ALTER TABLE public.student_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mentor_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_assignments ENABLE ROW LEVEL SECURITY;

-- Triggers for updated_at
CREATE TRIGGER update_student_profiles_updated_at BEFORE UPDATE ON public.student_profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_mentor_profiles_updated_at BEFORE UPDATE ON public.mentor_profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================
-- RLS POLICIES
-- =============================================

-- student_profiles policies
CREATE POLICY "Users can view own student profile" ON public.student_profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Mentors can view assigned student profiles" ON public.student_profiles
  FOR SELECT USING (auth.uid() = mentor_id);

CREATE POLICY "Admins/Managers can view all student profiles" ON public.student_profiles
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role IN ('ADMIN', 'MENTOR_MANAGER')
    )
  );

CREATE POLICY "Users can update own student profile" ON public.student_profiles
  FOR UPDATE USING (auth.uid() = id);

CREATE POLICY "Mentors can update assigned student profiles" ON public.student_profiles
  FOR UPDATE USING (auth.uid() = mentor_id);

CREATE POLICY "Admins/Managers can update all student profiles" ON public.student_profiles
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role IN ('ADMIN', 'MENTOR_MANAGER')
    )
  );

CREATE POLICY "Admins/Managers can insert student profiles" ON public.student_profiles
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role IN ('ADMIN', 'MENTOR_MANAGER')
    ) OR auth.uid() = id
  );

-- mentor_profiles policies
CREATE POLICY "Users can view all mentor profiles" ON public.mentor_profiles
  FOR SELECT USING (true);

CREATE POLICY "Mentors can update own profile" ON public.mentor_profiles
  FOR UPDATE USING (auth.uid() = id);

CREATE POLICY "Admins/Managers can update all mentor profiles" ON public.mentor_profiles
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role IN ('ADMIN', 'MENTOR_MANAGER')
    )
  );

CREATE POLICY "Admins/Managers can insert mentor profiles" ON public.mentor_profiles
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role IN ('ADMIN', 'MENTOR_MANAGER')
    ) OR auth.uid() = id
  );

-- student_assignments policies
CREATE POLICY "Users can view own assignments" ON public.student_assignments
  FOR SELECT USING (auth.uid() = student_id OR auth.uid() = mentor_id);

CREATE POLICY "Admins/Managers can view all assignments" ON public.student_assignments
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role IN ('ADMIN', 'MENTOR_MANAGER')
    )
  );

CREATE POLICY "Admins/Managers can manage assignments" ON public.student_assignments
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role IN ('ADMIN', 'MENTOR_MANAGER')
    )
  );

-- Enable Supabase Realtime for these tables
ALTER PUBLICATION supabase_realtime ADD TABLE public.student_profiles;
ALTER PUBLICATION supabase_realtime ADD TABLE public.mentor_profiles;
ALTER PUBLICATION supabase_realtime ADD TABLE public.student_assignments;
