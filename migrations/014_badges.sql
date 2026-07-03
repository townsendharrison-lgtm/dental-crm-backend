-- Database Migration: Badges and Achievements
-- Targets: public.badges, public.student_badges

-- Clean up any existing conflicting tables first
DROP TABLE IF EXISTS public.student_badges CASCADE;
DROP TABLE IF EXISTS public.badges CASCADE;

-- =============================================
-- BADGES TABLE (DIRECTORY DEFINITION)
-- =============================================
CREATE TABLE IF NOT EXISTS public.badges (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  icon TEXT NOT NULL, -- Lucide Icon Name (e.g. Award, Zap, Rocket, CheckCircle)
  color TEXT NOT NULL, -- CSS / Tailwind Color classes
  benchmark_type TEXT NOT NULL CHECK (benchmark_type IN ('PROGRESS', 'STRENGTH_SCORE', 'DAT', 'TASKS_COMPLETED', 'MEETINGS_ATTENDED')),
  benchmark_value NUMERIC(6, 2) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

-- =============================================
-- STUDENT EARNED BADGES TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS public.student_badges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  badge_id TEXT NOT NULL REFERENCES public.badges(id) ON DELETE CASCADE,
  earned_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  UNIQUE(student_id, badge_id) -- A student can only earn a badge once
);

-- =============================================
-- INDEXES & PERFORMANCE
-- =============================================
CREATE INDEX IF NOT EXISTS idx_student_badges_student_id ON public.student_badges(student_id);
CREATE INDEX IF NOT EXISTS idx_student_badges_badge_id ON public.student_badges(badge_id);

-- =============================================
-- ROW LEVEL SECURITY (RLS)
-- =============================================
ALTER TABLE public.badges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_badges ENABLE ROW LEVEL SECURITY;

-- Triggers for updated_at
CREATE TRIGGER update_badges_updated_at BEFORE UPDATE ON public.badges
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================
-- RLS POLICIES: BADGES
-- =============================================
CREATE POLICY "Anyone authenticated can view badges" ON public.badges
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage badges templates" ON public.badges
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  );

-- =============================================
-- RLS POLICIES: STUDENT BADGES
-- =============================================
CREATE POLICY "Users can view student badges" ON public.student_badges
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

CREATE POLICY "Admins and Managers can manually manage student badges" ON public.student_badges
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role IN ('ADMIN', 'MENTOR_MANAGER')
    )
  );

-- =============================================
-- REALTIME
-- =============================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.badges;
ALTER PUBLICATION supabase_realtime ADD TABLE public.student_badges;

-- =============================================
-- SEED DATA: SEED CORE BADGES DEFINITIONS
-- =============================================
INSERT INTO public.badges (id, name, description, icon, color, benchmark_type, benchmark_value) VALUES
('b1', 'High Achiever', 'Maintain a Strength Score above 90', 'Award', 'bg-amber-400/10 text-amber-400', 'STRENGTH_SCORE', 90.0),
('b2', 'DAT Master', 'Score 22 or higher on the DAT', 'Zap', 'bg-indigo-400/10 text-indigo-400', 'DAT', 22.0),
('b3', 'Momentum Builder', 'Reach 50% application progress', 'Rocket', 'bg-emerald-400/10 text-emerald-400', 'PROGRESS', 50.0),
('b4', 'Task Crusher', 'Complete 10 action items', 'CheckCircle', 'bg-rose-400/10 text-rose-400', 'TASKS_COMPLETED', 10.0)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  icon = EXCLUDED.icon,
  color = EXCLUDED.color,
  benchmark_type = EXCLUDED.benchmark_type,
  benchmark_value = EXCLUDED.benchmark_value;
