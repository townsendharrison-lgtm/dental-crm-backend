import { Router, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';
import {
  scheduleWorkflowTrigger,
  executeDueWorkflowActions,
  type WorkflowTrigger,
} from '../services/workflowEngine.js';

const router = Router();

router.use(authenticate);

// ─── GET /api/workflows ──────────────────────────────────────────────
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { data: workflows, error } = await supabaseAdmin
      .from('workflows')
      .select('*')
      .order('name', { ascending: true });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ workflows: workflows || [] });
  } catch (error: any) {
    console.error('List workflows error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── GET /api/workflows/pending ──────────────────────────────────────
router.get('/pending', authorize('ADMIN', 'MENTOR_MANAGER'), async (req: AuthRequest, res: Response) => {
  try {
    const { studentId } = req.query;

    let query = supabaseAdmin
      .from('pending_workflow_actions')
      .select('*, workflow:workflows(*)')
      .order('scheduled_for', { ascending: true });

    if (studentId) {
      query = query.eq('student_id', studentId as string);
    }

    const { data: queue, error } = await query;
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ queue: queue || [] });
  } catch (error: any) {
    console.error('Fetch pending queue error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/workflows/trigger ─────────────────────────────────────
router.post('/trigger', async (req: AuthRequest, res: Response) => {
  try {
    const { trigger, studentId, triggerData = {} } = req.body;

    if (!trigger || !studentId) {
      return res.status(400).json({ error: 'Trigger type and Student ID are required' });
    }

    const { data: studentUser, error: sErr } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('id', studentId)
      .maybeSingle();

    if (sErr || !studentUser) {
      return res.status(404).json({ error: 'Student user not found' });
    }

    const result = await scheduleWorkflowTrigger(
      trigger as WorkflowTrigger,
      studentId,
      triggerData
    );

    res.json({
      message: `Trigger event '${trigger}' processed`,
      matchedWorkflowsCount: result.matchedWorkflowsCount,
      scheduledActions: result.scheduledCount,
    });
  } catch (error: any) {
    console.error('Trigger workflow automation error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/workflows/execute-due ──────────────────────────────────
router.post('/execute-due', authorize('ADMIN', 'MENTOR_MANAGER'), async (req: AuthRequest, res: Response) => {
  try {
    const { executedCount } = await executeDueWorkflowActions();
    res.json({
      message:
        executedCount === 0
          ? 'No due actions to execute'
          : 'Due pending actions processing completed',
      executedCount,
    });
  } catch (error: any) {
    console.error('Execute due workflow actions error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── GET /api/workflows/:id ──────────────────────────────────────────
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const { data: workflow, error } = await supabaseAdmin
      .from('workflows')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error || !workflow) {
      return res.status(404).json({ error: 'Workflow not found' });
    }

    res.json(workflow);
  } catch (error: any) {
    console.error('Fetch workflow error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/workflows ─────────────────────────────────────────────
router.post('/', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { name, trigger, steps = [], isActive = true } = req.body;

    if (!name || !trigger) {
      return res.status(400).json({ error: 'Workflow name and trigger type are required' });
    }

    const { data: newWorkflow, error } = await supabaseAdmin
      .from('workflows')
      .insert({
        name,
        trigger,
        steps,
        is_active: isActive,
      })
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json(newWorkflow);
  } catch (error: any) {
    console.error('Create workflow template error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── PUT /api/workflows/:id ──────────────────────────────────────────
router.put('/:id', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('workflows')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Workflow template not found' });
    }

    const dbUpdates: any = { updated_at: new Date().toISOString() };
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (updates.trigger !== undefined) dbUpdates.trigger = updates.trigger;
    if (updates.steps !== undefined) dbUpdates.steps = updates.steps;
    if (updates.isActive !== undefined) dbUpdates.is_active = updates.isActive;
    if (updates.is_active !== undefined) dbUpdates.is_active = updates.is_active;

    const { data: updated, error } = await supabaseAdmin
      .from('workflows')
      .update(dbUpdates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json(updated);
  } catch (error: any) {
    console.error('Update workflow template error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── DELETE /api/workflows/:id ───────────────────────────────────────
router.delete('/:id', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('workflows')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Workflow template not found' });
    }

    const { error } = await supabaseAdmin.from('workflows').delete().eq('id', id);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ message: 'Workflow template deleted successfully' });
  } catch (error: any) {
    console.error('Delete workflow error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

export const workflowsRouter = router;
