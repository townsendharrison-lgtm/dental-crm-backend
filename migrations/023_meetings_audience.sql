-- Add audience column for meeting invite scopes
-- STUDENT | MENTORS | CUSTOM | GLOBAL

ALTER TABLE public.meetings
  ADD COLUMN IF NOT EXISTS audience TEXT;

ALTER TABLE public.meetings
  DROP CONSTRAINT IF EXISTS meetings_audience_check;

ALTER TABLE public.meetings
  ADD CONSTRAINT meetings_audience_check
  CHECK (audience IS NULL OR audience IN ('STUDENT', 'MENTORS', 'CUSTOM', 'GLOBAL'));

-- Backfill from existing type / student_id
UPDATE public.meetings
SET audience = CASE
  WHEN type = 'STUDENT_MEETING' THEN 'STUDENT'
  WHEN type = 'MANAGER_MEETING' THEN 'CUSTOM'
  WHEN type = 'GENERAL' AND student_id IS NULL THEN 'MENTORS'
  WHEN type = 'GENERAL' AND student_id IS NOT NULL THEN 'STUDENT'
  ELSE 'STUDENT'
END
WHERE audience IS NULL;

CREATE INDEX IF NOT EXISTS idx_meetings_audience ON public.meetings(audience);
