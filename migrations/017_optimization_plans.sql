-- Database Migration: Student Profile Optimization Plans
-- Targets: public.optimization_plans

-- Clean up any existing conflicting tables first
DROP TABLE IF EXISTS public.optimization_plans CASCADE;

-- =============================================
-- OPTIMIZATION PLANS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS public.optimization_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  snapshot TEXT NOT NULL,
  overall_score INTEGER DEFAULT 0,
  improvement_leverage_score INTEGER DEFAULT 0,
  kpis JSONB NOT NULL DEFAULT '{}'::jsonb, -- Schema: { academics: 'Strong'|'Moderate'|'Developing'|'Weak', experienceDepth, leadership, shadowing }
  roadmap JSONB NOT NULL DEFAULT '{}'::jsonb, -- Schema: { phase1: string[], phase2: string[], phase3: string[], phase4: string[] }
  risk_factors JSONB NOT NULL DEFAULT '[]'::jsonb, -- Schema: [{ factor, severity ('High'|'Medium'|'Low'), description, mitigation }]
  leverage_actions JSONB NOT NULL DEFAULT '[]'::jsonb, -- Schema: [{ title, description, impact ('High'|'Moderate'|'Lower') }]
  strengths TEXT[] NOT NULL DEFAULT '{}'::text[],
  gaps TEXT[] NOT NULL DEFAULT '{}'::text[],
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

-- =============================================
-- INDEXES & PERFORMANCE
-- =============================================
CREATE INDEX IF NOT EXISTS idx_optimization_plans_student_id ON public.optimization_plans(student_id);

-- =============================================
-- ROW LEVEL SECURITY (RLS)
-- =============================================
ALTER TABLE public.optimization_plans ENABLE ROW LEVEL SECURITY;

-- Trigger for updated_at
CREATE TRIGGER update_optimization_plans_updated_at BEFORE UPDATE ON public.optimization_plans
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================
-- RLS POLICIES
-- =============================================

CREATE POLICY "Users can view student optimization plan" ON public.optimization_plans
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

CREATE POLICY "Admins and Mentors can manage optimization plans" ON public.optimization_plans
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND u.role = 'ADMIN'
    ) OR
    EXISTS (
      SELECT 1 FROM public.student_profiles sp
      WHERE sp.id = student_id AND sp.mentor_id = auth.uid()
    )
  );

-- =============================================
-- REALTIME
-- =============================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.optimization_plans;
