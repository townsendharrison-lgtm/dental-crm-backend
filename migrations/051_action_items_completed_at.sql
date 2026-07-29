-- Track when an action item was checked off so we can auto-remove it after 7 days.

ALTER TABLE public.action_items
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP WITH TIME ZONE;

-- Backfill existing completed tasks from last update time.
UPDATE public.action_items
SET completed_at = COALESCE(completed_at, updated_at, created_at)
WHERE status = 'COMPLETED'
  AND completed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_action_items_completed_at
  ON public.action_items (status, completed_at)
  WHERE status = 'COMPLETED';
