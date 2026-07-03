-- Database Migration: Staff Tasks Table
-- Targets: public.staff_tasks

-- Clean up any existing conflicting tables first
DROP TABLE IF EXISTS public.staff_tasks CASCADE;

-- =============================================
-- STAFF TASKS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS public.staff_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assigned_to UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE, -- Mentor or Mentor Manager
  assigned_by UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE, -- Admin who created it
  task TEXT NOT NULL,
  description TEXT,
  due_date TIMESTAMP WITH TIME ZONE NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('HIGH', 'MEDIUM', 'LOW')) DEFAULT 'MEDIUM',
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'COMPLETED', 'OVERDUE')) DEFAULT 'PENDING',
  related_doc_id TEXT, -- optional reference to a doc
  student_id UUID REFERENCES public.users(id) ON DELETE SET NULL, -- optional student context
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

-- =============================================
-- INDEXES & PERFORMANCE
-- =============================================
CREATE INDEX IF NOT EXISTS idx_staff_tasks_assigned_to ON public.staff_tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_staff_tasks_assigned_by ON public.staff_tasks(assigned_by);
CREATE INDEX IF NOT EXISTS idx_staff_tasks_student_id ON public.staff_tasks(student_id);
CREATE INDEX IF NOT EXISTS idx_staff_tasks_due_date ON public.staff_tasks(due_date);

-- =============================================
-- ROW LEVEL SECURITY (RLS)
-- =============================================
ALTER TABLE public.staff_tasks ENABLE ROW LEVEL SECURITY;

-- Trigger for updated_at
CREATE TRIGGER update_staff_tasks_updated_at BEFORE UPDATE ON public.staff_tasks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================
-- RLS POLICIES
-- =============================================

CREATE POLICY "Staff can view assigned tasks" ON public.staff_tasks
  FOR SELECT USING (
    auth.uid() = assigned_to OR 
    auth.uid() = assigned_by OR
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  );

CREATE POLICY "Staff can update assigned tasks" ON public.staff_tasks
  FOR UPDATE USING (
    auth.uid() = assigned_to OR
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  );

CREATE POLICY "Admins can manage staff tasks" ON public.staff_tasks
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  );

-- Enable Supabase Realtime for this table
ALTER PUBLICATION supabase_realtime ADD TABLE public.staff_tasks;
