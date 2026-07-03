-- Database Migration: Student Documents Table
-- Targets: public.student_documents

-- Clean up any existing conflicting tables first
DROP TABLE IF EXISTS public.student_documents CASCADE;

-- =============================================
-- STUDENT DOCUMENTS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS public.student_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('Transcript', 'Resume', 'Letter of Recommendation', 'Post-Bac Transcript', 'DAT Report', 'Essay', 'Other')),
  url TEXT NOT NULL, -- storage file path within bucket
  status TEXT NOT NULL CHECK (status IN ('Pending Review', 'Reviewed', 'Needs Revision')) DEFAULT 'Pending Review',
  comment TEXT, -- visible feedback comments
  private_note TEXT, -- private notes visible only to mentors/staff
  uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

-- =============================================
-- INDEXES & PERFORMANCE
-- =============================================
CREATE INDEX IF NOT EXISTS idx_student_documents_student_id ON public.student_documents(student_id);
CREATE INDEX IF NOT EXISTS idx_student_documents_status ON public.student_documents(status);
CREATE INDEX IF NOT EXISTS idx_student_documents_type ON public.student_documents(type);

-- =============================================
-- ROW LEVEL SECURITY (RLS)
-- =============================================
ALTER TABLE public.student_documents ENABLE ROW LEVEL SECURITY;

-- Trigger for updated_at
CREATE TRIGGER update_student_documents_updated_at BEFORE UPDATE ON public.student_documents
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================
-- RLS POLICIES
-- =============================================

CREATE POLICY "Users can view own documents" ON public.student_documents
  FOR SELECT USING (
    auth.uid() = student_id OR
    EXISTS (
      SELECT 1 FROM public.student_profiles sp
      WHERE sp.id = student_id AND sp.mentor_id = auth.uid()
    ) OR
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role IN ('ADMIN', 'MENTOR_MANAGER')
    )
  );

CREATE POLICY "Students can insert own documents" ON public.student_documents
  FOR INSERT WITH CHECK (
    auth.uid() = student_id
  );

CREATE POLICY "Staff can update student documents" ON public.student_documents
  FOR UPDATE USING (
    auth.uid() = student_id OR
    EXISTS (
      SELECT 1 FROM public.student_profiles sp
      WHERE sp.id = student_id AND sp.mentor_id = auth.uid()
    ) OR
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role IN ('ADMIN', 'MENTOR_MANAGER')
    )
  );

CREATE POLICY "Users can delete own documents" ON public.student_documents
  FOR DELETE USING (
    auth.uid() = student_id OR
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  );

-- Enable Supabase Realtime for this table
ALTER PUBLICATION supabase_realtime ADD TABLE public.student_documents;
