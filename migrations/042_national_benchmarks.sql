-- Editable national benchmarks for Central Hub Analytics (Competitive Alignment Index)

CREATE TABLE IF NOT EXISTS public.national_benchmarks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  benchmark NUMERIC(10, 2) NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT TIMEZONE('utc', NOW()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT TIMEZONE('utc', NOW())
);

CREATE INDEX IF NOT EXISTS idx_national_benchmarks_sort
  ON public.national_benchmarks (sort_order ASC);

ALTER TABLE public.national_benchmarks ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS update_national_benchmarks_updated_at ON public.national_benchmarks;
CREATE TRIGGER update_national_benchmarks_updated_at
  BEFORE UPDATE ON public.national_benchmarks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE POLICY "Authenticated users can view national benchmarks"
  ON public.national_benchmarks FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage national benchmarks"
  ON public.national_benchmarks FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  );

INSERT INTO public.national_benchmarks (metric_key, label, benchmark, unit, description, sort_order) VALUES
  ('strengthScore', 'Strength Score', 85, '', 'Overall application competitiveness', 0),
  ('avgResponseTime', 'Avg. Response Time', 4, 'h', 'Engagement and responsiveness', 1),
  ('datAA', 'DAT Academic Average', 20.5, '', 'Standardized test performance', 2),
  ('datTS', 'DAT Total Science', 20.2, '', 'Science-specific test score', 3),
  ('shadowing', 'Shadowing Hours', 100, 'hrs', 'Clinical observation depth', 4),
  ('dental', 'Dental Experience', 150, 'hrs', 'Hands-on clinical exposure', 5),
  ('volunteering', 'Volunteering', 100, 'hrs', 'Community service commitment', 6),
  ('research', 'Research Exp.', 1, 'exp', 'Scientific inquiry involvement', 7),
  ('academic', 'Academic Enrichment', 1, 'exp', 'Summer programs and workshops', 8),
  ('leadership', 'Leadership Exp.', 1, 'exp', 'Organizational leadership roles', 9),
  ('dexterity', 'Manual Dexterity', 1, 'lvl', 'Fine motor skill proficiency', 10)
ON CONFLICT (metric_key) DO NOTHING;
