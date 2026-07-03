-- Database Migration: Admin Settings & Platform Configuration
-- Targets: public.admin_settings

-- Clean up any existing conflicting tables first
DROP TABLE IF EXISTS public.admin_settings CASCADE;

-- =============================================
-- ADMIN SETTINGS TABLE (Single Record Enforcement)
-- =============================================
CREATE TABLE IF NOT EXISTS public.admin_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1) DEFAULT 1,
  platform_name TEXT NOT NULL DEFAULT 'Dental CRM',
  support_email TEXT NOT NULL DEFAULT 'support@dentalcrm.com',
  maintenance_mode BOOLEAN NOT NULL DEFAULT FALSE,
  auto_reply_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  auto_reply_message TEXT DEFAULT 'Thank you for your message. An advisor will get back to you shortly.',
  welcome_template_student TEXT DEFAULT 'Welcome {{student_name}} to Dental CRM! We are excited to help you prepare for your applications.',
  welcome_template_mentor TEXT DEFAULT 'Welcome Mentor {{mentor_name}} to Dental CRM! Thank you for helping guide our students.',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

-- =============================================
-- ROW LEVEL SECURITY (RLS)
-- =============================================
ALTER TABLE public.admin_settings ENABLE ROW LEVEL SECURITY;

-- Trigger for updated_at
CREATE TRIGGER update_admin_settings_updated_at BEFORE UPDATE ON public.admin_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================
-- RLS POLICIES
-- =============================================
CREATE POLICY "Anyone authenticated can view platform settings" ON public.admin_settings
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage platform settings" ON public.admin_settings
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  );

-- =============================================
-- SEED INITIAL CONFIGURATION
-- =============================================
INSERT INTO public.admin_settings (
  id,
  platform_name,
  support_email,
  maintenance_mode,
  auto_reply_enabled,
  auto_reply_message,
  welcome_template_student,
  welcome_template_mentor
) VALUES (
  1,
  'Dental CRM',
  'support@dentalcrm.com',
  FALSE,
  FALSE,
  'Thank you for your message. An advisor will get back to you shortly.',
  'Welcome {{student_name}} to Dental CRM! We are excited to help you prepare for your applications.',
  'Welcome Mentor {{mentor_name}} to Dental CRM! Thank you for helping guide our students.'
) ON CONFLICT (id) DO NOTHING;

-- =============================================
-- REALTIME
-- =============================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.admin_settings;
