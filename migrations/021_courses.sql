-- Migration: Courses LMS (curriculum, modules, submissions)
-- Targets: public.courses, public.course_modules, public.course_submissions

DROP TABLE IF EXISTS public.course_submissions CASCADE;
DROP TABLE IF EXISTS public.course_modules CASCADE;
DROP TABLE IF EXISTS public.courses CASCADE;

CREATE TABLE IF NOT EXISTS public.courses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'General',
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE TABLE IF NOT EXISTS public.course_modules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL CHECK (type IN ('VIDEO', 'WORKSHEET', 'EXAM', 'CERTIFICATE')),
  content_url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_required BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE TABLE IF NOT EXISTS public.course_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  module_id UUID REFERENCES public.course_modules(id) ON DELETE SET NULL,
  student_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('CERTIFICATE', 'WORKSHEET', 'DRAFT', 'EXAM')),
  title TEXT,
  file_url TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'APPROVED', 'NEEDS_REVISION', 'REJECTED')),
  reviewer_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  reviewer_notes TEXT,
  reviewed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_courses_status ON public.courses(status);
CREATE INDEX IF NOT EXISTS idx_course_modules_course ON public.course_modules(course_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_course_submissions_status ON public.course_submissions(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_course_submissions_student ON public.course_submissions(student_id);

CREATE TRIGGER update_courses_updated_at BEFORE UPDATE ON public.courses
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_course_modules_updated_at BEFORE UPDATE ON public.course_modules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_course_submissions_updated_at BEFORE UPDATE ON public.course_submissions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_submissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view courses" ON public.courses
  FOR SELECT USING (
    status = 'PUBLISHED'
    OR EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role IN ('ADMIN', 'MENTOR_MANAGER', 'MENTOR')
    )
  );

CREATE POLICY "Admins manage courses" ON public.courses
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'ADMIN')
  );

CREATE POLICY "Staff can view modules" ON public.course_modules
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.courses c
      WHERE c.id = course_id AND (
        c.status = 'PUBLISHED'
        OR EXISTS (
          SELECT 1 FROM public.users
          WHERE id = auth.uid() AND role IN ('ADMIN', 'MENTOR_MANAGER', 'MENTOR')
        )
      )
    )
  );

CREATE POLICY "Admins manage modules" ON public.course_modules
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'ADMIN')
  );

CREATE POLICY "Students see own submissions; staff see all" ON public.course_submissions
  FOR SELECT USING (
    student_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role IN ('ADMIN', 'MENTOR_MANAGER', 'MENTOR')
    )
  );

CREATE POLICY "Students create own submissions" ON public.course_submissions
  FOR INSERT WITH CHECK (student_id = auth.uid());

CREATE POLICY "Staff review submissions" ON public.course_submissions
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role IN ('ADMIN', 'MENTOR_MANAGER')
    )
  );

CREATE POLICY "Admins delete submissions" ON public.course_submissions
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'ADMIN')
  );

-- Seed curriculum
INSERT INTO public.courses (id, title, description, category, status, sort_order) VALUES
  ('a1000000-0000-4000-8000-000000000001', 'Shadowing 101', 'Core shadowing curriculum: expectations, documentation, and certificates.', 'Shadowing', 'PUBLISHED', 1),
  ('a1000000-0000-4000-8000-000000000002', 'DAT Masterclass', 'DAT prep modules, practice worksheets, and progress checks.', 'DAT', 'PUBLISHED', 2),
  ('a1000000-0000-4000-8000-000000000003', 'Personal Statement Prep', 'Drafting, revision worksheets, and mentor review cycles.', 'Writing', 'PUBLISHED', 3)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.course_modules (course_id, title, description, type, content_url, sort_order) VALUES
  ('a1000000-0000-4000-8000-000000000001', 'Shadowing Overview Video', 'Intro to clinic etiquette and logging hours.', 'VIDEO', 'https://example.com/shadowing-intro', 1),
  ('a1000000-0000-4000-8000-000000000001', 'Hours Worksheet', 'Download and complete weekly shadowing log.', 'WORKSHEET', 'https://example.com/shadowing-worksheet', 2),
  ('a1000000-0000-4000-8000-000000000001', 'Certificate Upload', 'Upload dentist-signed shadowing certificate.', 'CERTIFICATE', NULL, 3),
  ('a1000000-0000-4000-8000-000000000002', 'DAT Strategy Video', 'Section-by-section DAT approach.', 'VIDEO', 'https://example.com/dat-strategy', 1),
  ('a1000000-0000-4000-8000-000000000002', 'Practice Exam', 'Timed practice set for AA/TS.', 'EXAM', 'https://example.com/dat-exam', 2),
  ('a1000000-0000-4000-8000-000000000003', 'Draft Outline Worksheet', 'Structure your personal statement.', 'WORKSHEET', 'https://example.com/ps-outline', 1),
  ('a1000000-0000-4000-8000-000000000003', 'Statement Draft', 'Submit draft for mentor review.', 'CERTIFICATE', NULL, 2);

ALTER PUBLICATION supabase_realtime ADD TABLE public.courses;
ALTER PUBLICATION supabase_realtime ADD TABLE public.course_modules;
ALTER PUBLICATION supabase_realtime ADD TABLE public.course_submissions;
