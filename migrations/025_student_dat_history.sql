-- DAT score history for students (snapshot each time DAT fields change)
CREATE TABLE IF NOT EXISTS public.student_dat_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  dat_score NUMERIC,
  dat_aa NUMERIC,
  dat_ts NUMERIC,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_student_dat_history_student_recorded
  ON public.student_dat_history (student_id, recorded_at ASC);

ALTER TABLE public.student_dat_history ENABLE ROW LEVEL SECURITY;
