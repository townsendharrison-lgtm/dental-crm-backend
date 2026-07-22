-- Public share links for read-only student profile snapshots

CREATE TABLE IF NOT EXISTS public.student_profile_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  revoked_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_student_profile_shares_student_id
  ON public.student_profile_shares(student_id);
CREATE INDEX IF NOT EXISTS idx_student_profile_shares_token
  ON public.student_profile_shares(token);

ALTER TABLE public.student_profile_shares ENABLE ROW LEVEL SECURITY;
