-- Track 15-minute pre-meeting reminder delivery so the cron does not double-send.
-- Cleared when a meeting is rescheduled to a new date.

ALTER TABLE public.meetings
  ADD COLUMN IF NOT EXISTS reminder_15_sent_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_meetings_reminder_15_pending
  ON public.meetings (date)
  WHERE completed = false AND reminder_15_sent_at IS NULL;
