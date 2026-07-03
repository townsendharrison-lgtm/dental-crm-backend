-- Database Migration: Popup / Advertisement System
-- Targets: public.popup_advertisements

-- Clean up any existing conflicting tables first
DROP TABLE IF EXISTS public.popup_advertisements CASCADE;

-- =============================================
-- POPUP ADVERTISEMENTS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS public.popup_advertisements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  image_url TEXT,
  cta_text TEXT,
  cta_url TEXT,
  background_color TEXT,
  text_color TEXT,
  target_role TEXT NOT NULL CHECK (target_role IN ('STUDENT', 'MENTOR', 'ADMIN', 'MENTOR_MANAGER', 'BOTH')) DEFAULT 'BOTH',
  start_date TIMESTAMP WITH TIME ZONE NOT NULL,
  end_date TIMESTAMP WITH TIME ZONE NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_by UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  dismissed_by UUID[] NOT NULL DEFAULT '{}'::uuid[], -- Array of user IDs who dismissed the popup
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

-- =============================================
-- INDEXES & PERFORMANCE
-- =============================================
CREATE INDEX IF NOT EXISTS idx_popups_targeting ON public.popup_advertisements(is_active, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_popups_target_role ON public.popup_advertisements(target_role);

-- =============================================
-- ROW LEVEL SECURITY (RLS)
-- =============================================
ALTER TABLE public.popup_advertisements ENABLE ROW LEVEL SECURITY;

-- Trigger for updated_at
CREATE TRIGGER update_popups_updated_at BEFORE UPDATE ON public.popup_advertisements
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================
-- RLS POLICIES
-- =============================================
CREATE POLICY "Anyone authenticated can view active targeted ads" ON public.popup_advertisements
  FOR SELECT USING (
    (is_active = TRUE AND start_date <= NOW() AND end_date >= NOW() AND (target_role = 'BOTH' OR target_role = (
      SELECT role::text FROM public.users WHERE id = auth.uid()
    ))) OR
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role IN ('ADMIN', 'MENTOR_MANAGER')
    )
  );

CREATE POLICY "Anyone authenticated can dismiss targeted ads" ON public.popup_advertisements
  FOR UPDATE USING (
    auth.role() = 'authenticated'
  )
  WITH CHECK (
    auth.role() = 'authenticated'
  );

CREATE POLICY "Admins can manage advertisements" ON public.popup_advertisements
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  );

-- =============================================
-- REALTIME
-- =============================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.popup_advertisements;
