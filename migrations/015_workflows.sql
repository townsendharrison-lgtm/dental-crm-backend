-- Database Migration: Workflow Automation Engine
-- Targets: public.workflows, public.pending_workflow_actions

-- Clean up any existing conflicting tables first
DROP TABLE IF EXISTS public.pending_workflow_actions CASCADE;
DROP TABLE IF EXISTS public.workflows CASCADE;

-- =============================================
-- WORKFLOWS TEMPLATE TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS public.workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('FIRST_ACCEPTANCE', 'APPLICATION_SUBMITTED', 'INTERVIEW_RECEIVED')),
  steps JSONB NOT NULL DEFAULT '[]'::jsonb, -- Schema: [{ id, type ('SEND_MESSAGE'), delayHours, messageTemplate, isFollowUp, followUpAfterHours }]
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

-- =============================================
-- PENDING WORKFLOW ACTIONS QUEUE
-- =============================================
CREATE TABLE IF NOT EXISTS public.pending_workflow_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  student_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  trigger_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  scheduled_for TIMESTAMP WITH TIME ZONE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'COMPLETED', 'CANCELLED')) DEFAULT 'PENDING',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

-- =============================================
-- INDEXES & PERFORMANCE
-- =============================================
CREATE INDEX IF NOT EXISTS idx_workflows_trigger ON public.workflows(trigger);
CREATE INDEX IF NOT EXISTS idx_pending_actions_scheduled_status ON public.pending_workflow_actions(scheduled_for, status);
CREATE INDEX IF NOT EXISTS idx_pending_actions_student_id ON public.pending_workflow_actions(student_id);

-- =============================================
-- ROW LEVEL SECURITY (RLS)
-- =============================================
ALTER TABLE public.workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pending_workflow_actions ENABLE ROW LEVEL SECURITY;

-- Triggers for updated_at
CREATE TRIGGER update_workflows_updated_at BEFORE UPDATE ON public.workflows
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_pending_actions_updated_at BEFORE UPDATE ON public.pending_workflow_actions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================
-- RLS POLICIES: WORKFLOWS
-- =============================================
CREATE POLICY "Anyone authenticated can view workflows" ON public.workflows
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage workflows templates" ON public.workflows
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  );

-- =============================================
-- RLS POLICIES: PENDING ACTIONS
-- =============================================
CREATE POLICY "Admins and Managers can manage actions queue" ON public.pending_workflow_actions
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role IN ('ADMIN', 'MENTOR_MANAGER')
    )
  );

CREATE POLICY "Mentors can view queue for assigned students" ON public.pending_workflow_actions
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.student_profiles sp
      WHERE sp.id = student_id AND sp.mentor_id = auth.uid()
    )
  );

-- =============================================
-- REALTIME
-- =============================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.workflows;
ALTER PUBLICATION supabase_realtime ADD TABLE public.pending_workflow_actions;
