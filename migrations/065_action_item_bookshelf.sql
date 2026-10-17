-- Preset student action items: GLOBAL (admin) or MENTOR (personal bookshelf)

CREATE TABLE IF NOT EXISTS public.action_item_bookshelf (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL CHECK (scope IN ('GLOBAL', 'MENTOR')),
  owner_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  priority TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('HIGH', 'MEDIUM', 'LOW')),
  resource_link TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  CONSTRAINT action_item_bookshelf_owner_check CHECK (
    (scope = 'GLOBAL' AND owner_id IS NULL) OR
    (scope = 'MENTOR' AND owner_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_action_item_bookshelf_scope
  ON public.action_item_bookshelf (scope, owner_id, sort_order, title);

DROP TRIGGER IF EXISTS update_action_item_bookshelf_updated_at ON public.action_item_bookshelf;
CREATE TRIGGER update_action_item_bookshelf_updated_at
  BEFORE UPDATE ON public.action_item_bookshelf
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.action_item_bookshelf ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.action_item_bookshelf IS 'Preset student action items: GLOBAL (admin) or MENTOR (personal)';
