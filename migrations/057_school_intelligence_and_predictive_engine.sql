-- Database Migration: School Intelligence, Evidence Citations, Rubrics, Historical Applications, and Predictive Calibration
-- Targets: public.school_evidence, public.school_scoring_rubrics, public.historical_applications

-- =============================================
-- SCHOOL EVIDENCE & CITATIONS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS public.school_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id TEXT NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN (
    'Prerequisites',
    'DAT Requirements',
    'GPA Requirements',
    'Shadowing & Volunteering',
    'Residency & Quotas',
    'Letters of Recommendation',
    'Rubrics & Weights',
    'Mission & Culture',
    'Interview Format',
    'General Information'
  )),
  field_key TEXT NOT NULL,
  field_label TEXT NOT NULL,
  extracted_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_type TEXT NOT NULL CHECK (source_type IN ('URL', 'PDF', 'TXT', 'IMAGE', 'MANUAL')),
  source_name TEXT NOT NULL,
  source_url TEXT,
  page_number INTEGER,
  raw_snippet TEXT NOT NULL,
  confidence_score NUMERIC(4, 2) DEFAULT 0.95,
  is_verified BOOLEAN DEFAULT FALSE,
  verified_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  verified_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_school_evidence_school_id ON public.school_evidence(school_id);
CREATE INDEX IF NOT EXISTS idx_school_evidence_category ON public.school_evidence(category);
CREATE INDEX IF NOT EXISTS idx_school_evidence_field_key ON public.school_evidence(field_key);

-- =============================================
-- SCHOOL SCORING RUBRICS & WEIGHTS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS public.school_scoring_rubrics (
  school_id TEXT PRIMARY KEY REFERENCES public.schools(id) ON DELETE CASCADE,
  weights JSONB NOT NULL DEFAULT '{
    "gpaWeight": 25,
    "datWeight": 30,
    "shadowingWeight": 15,
    "volunteeringWeight": 10,
    "researchWeight": 5,
    "inStateWeight": 10,
    "lorWeight": 5
  }'::jsonb,
  cutoffs JSONB NOT NULL DEFAULT '{
    "minCgpa": 3.0,
    "minSgpa": 3.0,
    "minDatAa": 18,
    "minDatTs": 18,
    "minDatPat": 17,
    "minShadowing": 50,
    "recommendedShadowing": 100,
    "minVolunteering": 50,
    "recommendedVolunteering": 100,
    "minLor": 3
  }'::jsonb,
  prerequisites JSONB NOT NULL DEFAULT '[]'::jsonb,
  holistic_factors JSONB NOT NULL DEFAULT '{
    "inStatePreferenceMultiplier": 1.25,
    "canadianDatAccepted": true,
    "communityCollegeAccepted": true,
    "casperRequired": false,
    "interviewFormat": "Traditional",
    "missionKeywords": []
  }'::jsonb,
  calibrated_from_outcomes_count INTEGER DEFAULT 0,
  last_calibrated_at TIMESTAMPTZ,
  calibration_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- =============================================
-- HISTORICAL STUDENT APPLICATIONS & OUTCOMES
-- =============================================
CREATE TABLE IF NOT EXISTS public.historical_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_name_anonymized TEXT NOT NULL,
  school_id TEXT NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  school_name TEXT NOT NULL,
  cycle TEXT NOT NULL DEFAULT '2025-2026',
  cgpa NUMERIC(4, 2) NOT NULL,
  sgpa NUMERIC(4, 2),
  dat_aa INTEGER NOT NULL,
  dat_ts INTEGER NOT NULL,
  dat_pat INTEGER,
  shadowing_hours INTEGER DEFAULT 0,
  volunteering_hours INTEGER DEFAULT 0,
  dental_experience_hours INTEGER DEFAULT 0,
  research_hours INTEGER DEFAULT 0,
  is_in_state BOOLEAN DEFAULT FALSE,
  state TEXT,
  applicant_type TEXT DEFAULT 'FIRST_TIME' CHECK (applicant_type IN ('FIRST_TIME', 'REAPPLICANT')),
  outcome TEXT NOT NULL CHECK (outcome IN ('ACCEPTED', 'INTERVIEWED', 'WAITLISTED', 'REJECTED')),
  source TEXT NOT NULL DEFAULT 'MANUAL_ENTRY' CHECK (source IN ('CRM_SYNC', 'CSV_UPLOAD', 'MANUAL_ENTRY', 'RESEARCH_CASE')),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_historical_apps_school_id ON public.historical_applications(school_id);
CREATE INDEX IF NOT EXISTS idx_historical_apps_outcome ON public.historical_applications(outcome);
CREATE INDEX IF NOT EXISTS idx_historical_apps_cycle ON public.historical_applications(cycle);

-- =============================================
-- RLS POLICIES
-- =============================================
ALTER TABLE public.school_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.school_scoring_rubrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.historical_applications ENABLE ROW LEVEL SECURITY;

-- Evidence: Anyone authenticated can read, admins & mentors can insert/update
CREATE POLICY "Authenticated can view school evidence" ON public.school_evidence
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Staff can manage school evidence" ON public.school_evidence
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role IN ('ADMIN', 'MENTOR_MANAGER', 'MENTOR')
    )
  );

-- Rubrics: Anyone authenticated can read, admins & mentors can update
CREATE POLICY "Authenticated can view school rubrics" ON public.school_scoring_rubrics
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Staff can manage school rubrics" ON public.school_scoring_rubrics
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role IN ('ADMIN', 'MENTOR_MANAGER')
    )
  );

-- Historical Applications: Authenticated staff can view and manage
CREATE POLICY "Authenticated staff can view historical applications" ON public.historical_applications
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role IN ('ADMIN', 'MENTOR_MANAGER', 'MENTOR')
    )
  );

CREATE POLICY "Admins can manage historical applications" ON public.historical_applications
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role IN ('ADMIN', 'MENTOR_MANAGER')
    )
  );

-- Realtime publication
ALTER PUBLICATION supabase_realtime ADD TABLE public.school_evidence;
ALTER PUBLICATION supabase_realtime ADD TABLE public.school_scoring_rubrics;
ALTER PUBLICATION supabase_realtime ADD TABLE public.historical_applications;
