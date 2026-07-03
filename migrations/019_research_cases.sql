-- Database Migration: Past Applicant Research Cases
-- Targets: public.research_cases

-- Clean up any existing conflicting tables first
DROP TABLE IF EXISTS public.research_cases CASCADE;

-- =============================================
-- RESEARCH CASES TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS public.research_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_name_anonymized TEXT NOT NULL,
  gpa NUMERIC(3,2) NOT NULL,
  dat_aa INTEGER NOT NULL,
  dat_ts INTEGER NOT NULL,
  major TEXT,
  undergrad_institution TEXT,
  shadowing_hours INTEGER DEFAULT 0,
  volunteering_hours INTEGER DEFAULT 0,
  research_hours INTEGER DEFAULT 0,
  accepted_schools TEXT[] NOT NULL DEFAULT '{}'::text[],
  rejected_schools TEXT[] NOT NULL DEFAULT '{}'::text[],
  matriculated_school TEXT,
  cycle TEXT NOT NULL,
  special_circumstances TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

-- =============================================
-- INDEXES & PERFORMANCE
-- =============================================
CREATE INDEX IF NOT EXISTS idx_research_cases_metrics ON public.research_cases(gpa, dat_aa);
CREATE INDEX IF NOT EXISTS idx_research_cases_cycle ON public.research_cases(cycle);

-- =============================================
-- ROW LEVEL SECURITY (RLS)
-- =============================================
ALTER TABLE public.research_cases ENABLE ROW LEVEL SECURITY;

-- Trigger for updated_at
CREATE TRIGGER update_research_cases_updated_at BEFORE UPDATE ON public.research_cases
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================
-- RLS POLICIES
-- =============================================

CREATE POLICY "Staff roles can view research cases" ON public.research_cases
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role IN ('ADMIN', 'MENTOR_MANAGER', 'MENTOR')
    )
  );

CREATE POLICY "Admins can manage research cases" ON public.research_cases
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  );

-- =============================================
-- SEED HISTORICAL APPLICANTS RESEARCH CASES
-- =============================================
INSERT INTO public.research_cases (
  student_name_anonymized,
  gpa,
  dat_aa,
  dat_ts,
  major,
  undergrad_institution,
  shadowing_hours,
  volunteering_hours,
  research_hours,
  accepted_schools,
  rejected_schools,
  matriculated_school,
  cycle,
  special_circumstances
) VALUES
(
  'Applicant A',
  3.85,
  22,
  21,
  'Biology',
  'Boston University',
  120,
  200,
  50,
  ARRAY['Harvard School of Dental Medicine', 'Tufts University School of Dental Medicine', 'Columbia University College of Dental Medicine'],
  ARRAY['University of Pennsylvania School of Dental Medicine'],
  'Harvard School of Dental Medicine',
  '2023-2024',
  'First-time applicant, strong letters of recommendation.'
),
(
  'Applicant B',
  3.42,
  19,
  19,
  'Psychology',
  'University of Massachusetts',
  150,
  80,
  0,
  ARRAY['Boston University Henry M. Goldman School of Dental Medicine'],
  ARRAY['Tufts University School of Dental Medicine', 'New York University College of Dentistry'],
  'Boston University Henry M. Goldman School of Dental Medicine',
  '2023-2024',
  'Non-traditional major, reapplicant, significantly improved shadowing hours.'
),
(
  'Applicant C',
  3.90,
  25,
  24,
  'Biochemistry',
  'University of California, Berkeley',
  200,
  150,
  300,
  ARRAY['University of Pennsylvania School of Dental Medicine', 'Harvard School of Dental Medicine', 'UCSF School of Dentistry'],
  ARRAY[]::text[],
  'University of Pennsylvania School of Dental Medicine',
  '2024-2025',
  'Extensive research experience, co-authored publication.'
)
ON CONFLICT DO NOTHING;

-- =============================================
-- REALTIME
-- =============================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.research_cases;
