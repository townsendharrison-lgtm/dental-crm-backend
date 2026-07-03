-- Database Migration: Dental Schools Database & Student Selections Table
-- Targets: public.schools, public.student_schools

-- Clean up any existing conflicting tables first
DROP TABLE IF EXISTS public.student_schools CASCADE;
DROP TABLE IF EXISTS public.schools CASCADE;

-- =============================================
-- SCHOOLS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS public.schools (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL UNIQUE,
  location TEXT NOT NULL,
  strength_score_avg INTEGER DEFAULT 0,
  dat_avg NUMERIC(4, 2) DEFAULT 0.0,
  avg_gpa NUMERIC(4, 2) DEFAULT 0.0,
  acceptance_rate NUMERIC(5, 2),
  is_acceptance_rate NUMERIC(5, 2), -- in-state acceptance rate
  oos_acceptance_rate NUMERIC(5, 2), -- out-of-state acceptance rate
  cc_credits BOOLEAN DEFAULT TRUE,
  tuition TEXT,
  notes TEXT,
  in_state_enrollment INTEGER,
  out_of_state_enrollment INTEGER,
  male_enrollment INTEGER,
  female_enrollment INTEGER,
  ethnicity JSONB DEFAULT '{}'::jsonb,
  min_dat_5th NUMERIC(4, 2),
  min_cgpa_5th NUMERIC(4, 2),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

-- =============================================
-- STUDENT SCHOOL LISTS & APPLICATIONS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS public.student_schools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  school_id TEXT NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('Reach', 'Target', 'Safety')),
  status TEXT NOT NULL CHECK (status IN ('Interested', 'Applying', 'Applied', 'Interviewed', 'Accepted', 'Waitlisted', 'Rejected')) DEFAULT 'Interested',
  applied_date DATE,
  interview_date DATE,
  decision_date DATE,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  UNIQUE(student_id, school_id) -- A student cannot add duplicate school selections
);

-- =============================================
-- INDEXES & PERFORMANCE
-- =============================================
CREATE INDEX IF NOT EXISTS idx_student_schools_student_id ON public.student_schools(student_id);
CREATE INDEX IF NOT EXISTS idx_student_schools_school_id ON public.student_schools(school_id);
CREATE INDEX IF NOT EXISTS idx_schools_name ON public.schools(name);

-- =============================================
-- ROW LEVEL SECURITY (RLS)
-- =============================================
ALTER TABLE public.schools ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_schools ENABLE ROW LEVEL SECURITY;

-- Triggers for updated_at
CREATE TRIGGER update_schools_updated_at BEFORE UPDATE ON public.schools
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_student_schools_updated_at BEFORE UPDATE ON public.student_schools
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================
-- RLS POLICIES: SCHOOLS
-- =============================================
CREATE POLICY "Anyone authenticated can view schools" ON public.schools
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage schools directory" ON public.schools
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  );

-- =============================================
-- RLS POLICIES: STUDENT SCHOOLS SELECTIONS
-- =============================================
CREATE POLICY "Users can view student schools" ON public.student_schools
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

CREATE POLICY "Students can manage own selections" ON public.student_schools
  FOR ALL USING (
    auth.uid() = student_id OR
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND role = 'ADMIN'
    )
  );

-- =============================================
-- REALTIME
-- =============================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.schools;
ALTER PUBLICATION supabase_realtime ADD TABLE public.student_schools;

-- =============================================
-- SEED DATA: DENTAL SCHOOLS DATABASE
-- =============================================
INSERT INTO public.schools (id, name, location, strength_score_avg, dat_avg, avg_gpa, acceptance_rate, is_acceptance_rate, oos_acceptance_rate, cc_credits, tuition, ethnicity) VALUES
('sch1', 'Harvard School of Dental Medicine', 'Boston, MA', 95, 24.0, 3.92, 3.5, 4.2, 3.1, false, '$68,000', '{"white": 40, "black": 8, "hispanic": 12, "asian": 35, "other": 5}'),
('sch2', 'UPenn School of Dental Medicine', 'Philadelphia, PA', 92, 23.0, 3.85, 5.1, 6.2, 4.5, true, '$72,000', '{"white": 42, "black": 7, "hispanic": 10, "asian": 36, "other": 5}'),
('sch3', 'UCLA School of Dentistry', 'Los Angeles, CA', 88, 22.0, 3.78, 4.8, 7.5, 2.1, true, '$55,000', '{"white": 32, "black": 5, "hispanic": 18, "asian": 40, "other": 5}'),
('sch4', 'NYU College of Dentistry', 'New York, NY', 85, 21.0, 3.65, 12.4, 15.2, 10.8, true, '$85,000', '{"white": 45, "black": 9, "hispanic": 11, "asian": 30, "other": 5}'),
('sch5', 'Tufts University School of Dental Medicine', 'Boston, MA', 82, 20.0, 3.58, 10.5, 12.1, 9.2, true, '$78,000', '{"white": 48, "black": 6, "hispanic": 9, "asian": 32, "other": 5}'),
('sch6', 'Boston University Henry M. Goldman School', 'Boston, MA', 80, 20.0, 3.55, 11.2, 13.5, 10.1, true, '$82,000', '{"white": 46, "black": 7, "hispanic": 10, "asian": 32, "other": 5}'),
('sch7', 'A.T. Still University of Missouri', 'Kirksville, MO', 84, 19.3, 3.56, 25.0, 21.0, 79.0, true, '$62,000', '{"white": 65, "black": 4, "hispanic": 8, "asian": 18, "other": 5}'),
('sch8', 'A.T. Still University of Arizona', 'Mesa, AZ', 86, 20.1, 3.62, 2.68, 3.5, 2.2, true, '$65,000', '{"white": 58, "black": 5, "hispanic": 15, "asian": 17, "other": 5}')
ON CONFLICT (name) DO UPDATE SET
  location = EXCLUDED.location,
  strength_score_avg = EXCLUDED.strength_score_avg,
  dat_avg = EXCLUDED.dat_avg,
  avg_gpa = EXCLUDED.avg_gpa,
  acceptance_rate = EXCLUDED.acceptance_rate,
  is_acceptance_rate = EXCLUDED.is_acceptance_rate,
  oos_acceptance_rate = EXCLUDED.oos_acceptance_rate,
  cc_credits = EXCLUDED.cc_credits,
  tuition = EXCLUDED.tuition,
  ethnicity = EXCLUDED.ethnicity;
