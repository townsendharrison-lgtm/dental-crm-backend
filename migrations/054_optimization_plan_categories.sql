-- Persist strategy plan category accordion + manual dexterity on optimization_plans

ALTER TABLE public.optimization_plans
  ADD COLUMN IF NOT EXISTS categories JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS manual_dexterity JSONB;

COMMENT ON COLUMN public.optimization_plans.categories IS
  'Per-category strategy blocks: shadowing, research, academic, dental, employment, volunteering';
COMMENT ON COLUMN public.optimization_plans.manual_dexterity IS
  'Manual dexterity status, description, and recommendations';
