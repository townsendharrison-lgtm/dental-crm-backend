-- Timeline cards (typed milestones) + range/goals + preset bookshelf

ALTER TABLE public.student_profiles
  ADD COLUMN IF NOT EXISTS timeline_start TEXT,
  ADD COLUMN IF NOT EXISTS timeline_end TEXT,
  ADD COLUMN IF NOT EXISTS timeline_month_goals JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.student_milestones
  ADD COLUMN IF NOT EXISTS card_type TEXT NOT NULL DEFAULT 'Milestone',
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS resource_links JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS target_date DATE,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_by_role TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'student_milestones_card_type_check'
  ) THEN
    ALTER TABLE public.student_milestones
      ADD CONSTRAINT student_milestones_card_type_check
      CHECK (card_type IN ('Meeting', 'Milestone', 'Task', 'Other'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.timeline_bookshelf_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL CHECK (scope IN ('GLOBAL', 'MENTOR')),
  owner_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
  card_type TEXT NOT NULL DEFAULT 'Milestone'
    CHECK (card_type IN ('Meeting', 'Milestone', 'Task', 'Other')),
  title TEXT NOT NULL,
  description TEXT,
  resource_links JSONB NOT NULL DEFAULT '[]'::jsonb,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  CONSTRAINT timeline_bookshelf_owner_check CHECK (
    (scope = 'GLOBAL' AND owner_id IS NULL) OR
    (scope = 'MENTOR' AND owner_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_timeline_bookshelf_scope
  ON public.timeline_bookshelf_items (scope, owner_id);

DROP TRIGGER IF EXISTS update_timeline_bookshelf_items_updated_at ON public.timeline_bookshelf_items;
CREATE TRIGGER update_timeline_bookshelf_items_updated_at
  BEFORE UPDATE ON public.timeline_bookshelf_items
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.timeline_bookshelf_items ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.admin_settings
  ADD COLUMN IF NOT EXISTS timeline_card_colors JSONB;

UPDATE public.admin_settings
SET timeline_card_colors = COALESCE(
  timeline_card_colors,
  '{
    "Meeting": "#6366f1",
    "Milestone": "#10b981",
    "Task": "#f59e0b",
    "Other": "#94a3b8"
  }'::jsonb
)
WHERE id = 1;

COMMENT ON COLUMN public.student_profiles.timeline_start IS 'YYYY-MM start of application roadmap';
COMMENT ON COLUMN public.student_profiles.timeline_end IS 'YYYY-MM end of application roadmap';
COMMENT ON COLUMN public.student_profiles.timeline_month_goals IS 'Map of YYYY-MM → primary goal text';
COMMENT ON TABLE public.timeline_bookshelf_items IS 'Preset timeline cards: GLOBAL (admin) or MENTOR (personal)';
