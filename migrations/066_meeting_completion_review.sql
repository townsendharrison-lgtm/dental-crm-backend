-- Official meeting record, commitment follow-up, and the AI draft that prefills the complete-meeting form.

ALTER TABLE public.meetings
  ADD COLUMN IF NOT EXISTS ai_draft JSONB,
  ADD COLUMN IF NOT EXISTS official_summary TEXT,
  ADD COLUMN IF NOT EXISTS commitments_completed TEXT,
  ADD COLUMN IF NOT EXISTS incomplete_reason TEXT,
  ADD COLUMN IF NOT EXISTS incomplete_reason_detail TEXT,
  ADD COLUMN IF NOT EXISTS verified_summary BOOLEAN,
  ADD COLUMN IF NOT EXISTS verified_school_timeline BOOLEAN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'meetings_commitments_completed_check'
  ) THEN
    ALTER TABLE public.meetings
      ADD CONSTRAINT meetings_commitments_completed_check
      CHECK (commitments_completed IS NULL OR commitments_completed IN ('ALL', 'SOME', 'NONE'));
  END IF;
END $$;

COMMENT ON COLUMN public.meetings.ai_draft IS 'Gemini parse used to prefill the complete-meeting form. Not saved as tasks until the mentor submits.';
COMMENT ON COLUMN public.meetings.official_summary IS 'Mentor-reviewed meeting record submitted from the complete-meeting form.';
