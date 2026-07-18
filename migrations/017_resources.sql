-- Database Migration: Student Resources directory
-- Targets: public.resources

DROP TABLE IF EXISTS public.resources CASCADE;

CREATE TABLE IF NOT EXISTS public.resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  estimated_time TEXT NOT NULL DEFAULT '5m',
  category TEXT NOT NULL DEFAULT 'General',
  icon TEXT NOT NULL DEFAULT 'BookOpen',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_resources_sort ON public.resources(sort_order, title);

ALTER TABLE public.resources ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER update_resources_updated_at BEFORE UPDATE ON public.resources
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE POLICY "Anyone authenticated can view active resources" ON public.resources
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage resources" ON public.resources
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  );

ALTER PUBLICATION supabase_realtime ADD TABLE public.resources;

INSERT INTO public.resources (title, url, estimated_time, category, icon, sort_order) VALUES
  ('Find a Dentist', '/student/find-dentist', '5m', 'Outreach', 'Search', 1),
  ('DAT Accelerator', 'https://dataccelerator.com', 'Ongoing', 'Study', 'Zap', 2),
  ('Mentor Assistant', '/student/mentor-assistant', '10m', 'Support', 'MessageCircle', 3),
  ('Personal Statement Help', '#', '30m', 'Writing', 'FileText', 4),
  ('Letter Vault', '/student/letters/vault', '15m', 'Documents', 'Shield', 5),
  ('Casper Hub', '#', '20m', 'Testing', 'Target', 6),
  ('Interview Hub', '#', '45m', 'Interview', 'Users', 7),
  ('Competitive Alignment Index', '#', '10m', 'Analytics', 'BarChart', 8);
