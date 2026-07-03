-- Database Migration: Survey System Tables
-- Targets: public.surveys, public.survey_responses

-- Clean up any existing conflicting tables first
DROP TABLE IF EXISTS public.survey_responses CASCADE;
DROP TABLE IF EXISTS public.surveys CASCADE;

-- =============================================
-- SURVEYS TEMPLATE TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS public.surveys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  questions JSONB NOT NULL DEFAULT '[]'::jsonb, -- question schema: [{ id, type ('TEXT'|'MULTIPLE_CHOICE'|'RATING'), questionText, options: string[], required: boolean }]
  target_role TEXT NOT NULL CHECK (target_role IN ('STUDENT', 'MENTOR', 'BOTH')) DEFAULT 'BOTH',
  is_active BOOLEAN DEFAULT TRUE,
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

-- =============================================
-- SURVEY RESPONSES TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS public.survey_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_id UUID NOT NULL REFERENCES public.surveys(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  answers JSONB NOT NULL DEFAULT '[]'::jsonb, -- answers schema: [{ questionId, answerText }]
  submitted_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  UNIQUE(survey_id, user_id) -- Only one response allowed per survey per user
);

-- =============================================
-- INDEXES & PERFORMANCE
-- =============================================
CREATE INDEX IF NOT EXISTS idx_surveys_target_role ON public.surveys(target_role);
CREATE INDEX IF NOT EXISTS idx_survey_responses_survey_id ON public.survey_responses(survey_id);
CREATE INDEX IF NOT EXISTS idx_survey_responses_user_id ON public.survey_responses(user_id);

-- =============================================
-- ROW LEVEL SECURITY (RLS)
-- =============================================
ALTER TABLE public.surveys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.survey_responses ENABLE ROW LEVEL SECURITY;

-- Triggers for updated_at
CREATE TRIGGER update_surveys_updated_at BEFORE UPDATE ON public.surveys
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================
-- RLS POLICIES: SURVEYS
-- =============================================

CREATE POLICY "Users can view active surveys" ON public.surveys
  FOR SELECT USING (
    is_active = TRUE OR
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role IN ('ADMIN', 'MENTOR_MANAGER')
    )
  );

CREATE POLICY "Admins can manage surveys template" ON public.surveys
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  );

-- =============================================
-- RLS POLICIES: SURVEY RESPONSES
-- =============================================

CREATE POLICY "Users can view own responses" ON public.survey_responses
  FOR SELECT USING (
    auth.uid() = user_id OR
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND u.role IN ('ADMIN', 'MENTOR_MANAGER')
    )
  );

CREATE POLICY "Anyone authenticated can submit responses" ON public.survey_responses
  FOR INSERT WITH CHECK (
    auth.uid() = user_id AND
    EXISTS (
      SELECT 1 FROM public.surveys s
      WHERE s.id = survey_id AND s.is_active = TRUE
    )
  );

-- =============================================
-- REALTIME
-- =============================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.surveys;
ALTER PUBLICATION supabase_realtime ADD TABLE public.survey_responses;
