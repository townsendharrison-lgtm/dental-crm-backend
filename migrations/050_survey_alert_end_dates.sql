-- Optional end dates for surveys and system alert (broadcast) notifications.

ALTER TABLE public.surveys
  ADD COLUMN IF NOT EXISTS end_date TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.surveys.end_date IS
  'When set, the survey stops accepting responses after this timestamp';

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS end_date TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.notifications.end_date IS
  'When set (broadcasts), hide from recipient inboxes after this timestamp';

CREATE INDEX IF NOT EXISTS idx_notifications_end_date
  ON public.notifications (end_date)
  WHERE end_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_surveys_end_date
  ON public.surveys (end_date)
  WHERE end_date IS NOT NULL;
