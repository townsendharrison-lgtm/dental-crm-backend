-- ==============================================
-- LOR (Letter of Recommendation) TABLES
-- Run this in your Supabase SQL Editor
-- ==============================================

-- LOR Requests — persistent storage for all letter requests
CREATE TABLE IF NOT EXISTS public.lor_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID REFERENCES public.users(id) ON DELETE SET NULL, -- nullable for guest students
  student_name TEXT NOT NULL,
  student_email TEXT, -- for guest students who don't have accounts
  writer_name TEXT NOT NULL,
  writer_email TEXT NOT NULL,
  due_date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('REQUESTED', 'UPLOADED', 'REVIEWED', 'DECLINED')) DEFAULT 'REQUESTED',
  access_code TEXT NOT NULL UNIQUE,
  document_url TEXT, -- Supabase Storage path
  decline_reason TEXT, -- Admin's reason for declining
  requested_at TIMESTAMPTZ DEFAULT now(),
  uploaded_at TIMESTAMPTZ,
  reviewed_at TIMESTAMPTZ,
  last_reminder_sent_at TIMESTAMPTZ,
  reminders_stopped BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_lor_requests_student_id ON public.lor_requests(student_id);
CREATE INDEX IF NOT EXISTS idx_lor_requests_status ON public.lor_requests(status);
CREATE INDEX IF NOT EXISTS idx_lor_requests_access_code ON public.lor_requests(access_code);
CREATE INDEX IF NOT EXISTS idx_lor_requests_student_email ON public.lor_requests(student_email);

ALTER TABLE public.lor_requests ENABLE ROW LEVEL SECURITY;

-- Service role can do everything (backend uses service role key)
CREATE POLICY "Service role manages lor_requests"
  ON public.lor_requests FOR ALL
  USING (true);

-- ==============================================
-- LOR Email Config — single row storing admin's email config
-- ==============================================
CREATE TABLE IF NOT EXISTS public.lor_email_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  design JSONB NOT NULL DEFAULT '{"primaryColor": "#6366f1", "logoUrl": "", "bannerUrl": ""}',
  content JSONB NOT NULL DEFAULT '{"subject": "Letter of Recommendation Request for {{student_name}}", "body": "Dear {{writer_name}},\n\nYou have been requested to write a letter of recommendation for {{student_name}}.\n\nPlease use the button below to upload your letter by {{due_date}}.\n\nThank you for your support!", "requirements": "• Must be on official letterhead\n• Include your signature\n• PDF format only\n• 1-2 pages recommended", "exampleLetter": "", "requirementsPdfUrl": "", "exampleLetterPdfUrl": ""}',
  reminder_schedule INTEGER[] NOT NULL DEFAULT '{-7, -3, 0, 3, 7}',
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.lor_email_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role manages lor_email_config"
  ON public.lor_email_config FOR ALL
  USING (true);

-- Insert default config row if none exists
INSERT INTO public.lor_email_config (id, design, content, reminder_schedule)
SELECT gen_random_uuid(),
  '{"primaryColor": "#6366f1", "logoUrl": "", "bannerUrl": ""}'::jsonb,
  '{"subject": "Letter of Recommendation Request for {{student_name}}", "body": "Dear {{writer_name}},\n\nYou have been requested to write a letter of recommendation for {{student_name}}.\n\nPlease use the button below to upload your letter by {{due_date}}.\n\nThank you for your support!", "requirements": "• Must be on official letterhead\n• Include your signature\n• PDF format only\n• 1-2 pages recommended", "exampleLetter": "", "requirementsPdfUrl": "", "exampleLetterPdfUrl": ""}'::jsonb,
  '{-7, -3, 0, 3, 7}'::integer[]
WHERE NOT EXISTS (SELECT 1 FROM public.lor_email_config);

-- ==============================================
-- LOR Email Log — tracks every email sent
-- ==============================================
CREATE TABLE IF NOT EXISTS public.lor_email_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lor_request_id UUID NOT NULL REFERENCES public.lor_requests(id) ON DELETE CASCADE,
  email_type TEXT NOT NULL CHECK (email_type IN ('INITIAL', 'REMINDER', 'DECLINED_REUPLOAD')),
  sent_at TIMESTAMPTZ DEFAULT now(),
  recipient_email TEXT NOT NULL,
  days_relative INTEGER -- for reminders: -7, -3, 0, 3, 7 etc.
);

CREATE INDEX IF NOT EXISTS idx_lor_email_log_request ON public.lor_email_log(lor_request_id);

ALTER TABLE public.lor_email_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role manages lor_email_log"
  ON public.lor_email_log FOR ALL
  USING (true);

-- ==============================================
-- Supabase Storage Bucket for LOR documents
-- Note: Run this ONLY if the bucket doesn't exist yet.
-- You can also create this via the Supabase Dashboard → Storage.
-- ==============================================
-- INSERT INTO storage.buckets (id, name, public)
-- VALUES ('lor-documents', 'lor-documents', false)
-- ON CONFLICT DO NOTHING;
