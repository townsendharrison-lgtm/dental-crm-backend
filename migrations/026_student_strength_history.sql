-- Strength score history (snapshot each time the computed score changes)
CREATE TABLE IF NOT EXISTS public.student_strength_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  strength_score INTEGER NOT NULL CHECK (strength_score >= 0 AND strength_score <= 100),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_student_strength_history_student_recorded
  ON public.student_strength_history (student_id, recorded_at ASC);

ALTER TABLE public.student_strength_history ENABLE ROW LEVEL SECURITY;
