import { Router, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';

const router = Router();

// All routes require authentication
router.use(authenticate);

// ─── GET /api/workflows ──────────────────────────────────────────────
// List all workflow templates
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
// View the queue of scheduled pending actions (Admin/Manager only)
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

// ─── GET /api/workflows/:id ──────────────────────────────────────────
// Fetch single workflow template details
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
// Create workflow template (Admin only)
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
        is_active: isActive
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
// Update workflow template (Admin only)
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
// Remove workflow template (Admin only)
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

    const { error } = await supabaseAdmin
      .from('workflows')
      .delete()
      .eq('id', id);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ message: 'Workflow template deleted successfully' });
  } catch (error: any) {
    console.error('Delete workflow error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/workflows/trigger ─────────────────────────────────────
// Manually/Programmatically trigger a workflow trigger event
router.post('/trigger', async (req: AuthRequest, res: Response) => {
  try {
    const { trigger, studentId, triggerData = {} } = req.body;

    if (!trigger || !studentId) {
      return res.status(400).json({ error: 'Trigger type and Student ID are required' });
    }

    // Verify student user exists
    const { data: studentUser, error: sErr } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('id', studentId)
      .maybeSingle();

    if (sErr || !studentUser) {
      return res.status(404).json({ error: 'Student user not found' });
    }

    // Fetch active workflows matching this trigger
    const { data: matchingWorkflows, error: wErr } = await supabaseAdmin
      .from('workflows')
      .select('*')
      .eq('trigger', trigger)
      .eq('is_active', true);

    if (wErr) {
      return res.status(500).json({ error: wErr.message });
    }

    const scheduledActions: any[] = [];

    // Schedule actions in queue for all matching workflows
    if (matchingWorkflows && matchingWorkflows.length > 0) {
      for (const workflow of matchingWorkflows) {
        const stepsList = (workflow.steps || []) as any[];

        for (const step of stepsList) {
          const delayMs = (step.delayHours || 0) * 60 * 60 * 1000;
          const scheduledFor = new Date(Date.now() + delayMs).toISOString();

          const { data: action, error: aErr } = await supabaseAdmin
            .from('pending_workflow_actions')
            .insert({
              workflow_id: workflow.id,
              step_id: step.id,
              student_id: studentId,
              trigger_data: triggerData,
              scheduled_for: scheduledFor,
              status: 'PENDING'
            })
            .select()
            .single();

          if (!aErr && action) {
            scheduledActions.push(action);
          }
        }
      }
    }

    res.json({
      message: `Trigger event '${trigger}' processed`,
      matchedWorkflowsCount: matchingWorkflows ? matchingWorkflows.length : 0,
      scheduledActions
    });
  } catch (error: any) {
    console.error('Trigger workflow automation error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/workflows/execute-due ──────────────────────────────────
// Scan queue for due items and run action executions (e.g. system messaging)
router.post('/execute-due', async (req: AuthRequest, res: Response) => {
  try {
    const now = new Date().toISOString();

    // 1. Fetch pending actions scheduled in the past
    const { data: dueActions, error: fetchErr } = await supabaseAdmin
      .from('pending_workflow_actions')
      .select('*, workflow:workflows(*)')
      .eq('status', 'PENDING')
      .lte('scheduled_for', now);

    if (fetchErr) {
      return res.status(500).json({ error: fetchErr.message });
    }

    if (!dueActions || dueActions.length === 0) {
      return res.json({ message: 'No due actions to execute', executedCount: 0 });
    }

    let executedCount = 0;

    // Get a default system sender ID (Admin user)
    const { data: adminUser } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('role', 'ADMIN')
      .limit(1)
      .maybeSingle();

    for (const action of dueActions) {
      const workflowTemplate = action.workflow;
      if (!workflowTemplate) {
        continue;
      }

      // Find the specific step details
      const stepsList = (workflowTemplate.steps || []) as any[];
      const step = stepsList.find((s: any) => s.id === action.step_id);

      if (!step) {
        // Step details missing, skip or fail it
        await supabaseAdmin
          .from('pending_workflow_actions')
          .update({ status: 'CANCELLED' })
          .eq('id', action.id);
        continue;
      }

      if (step.type === 'SEND_MESSAGE') {
        const studentId = action.student_id;

        // Fetch student profile details to customize template variables
        const { data: studentUser } = await supabaseAdmin
          .from('users')
          .select('name')
          .eq('id', studentId)
          .maybeSingle();

        const studentName = studentUser?.name || 'Student';

        // Parse templated strings
        let formattedText = step.messageTemplate || '';
        formattedText = formattedText.replace(/\{\{\s*student_name\s*\}\}/g, studentName);
        formattedText = formattedText.replace(/\{\{\s*name\s*\}\}/g, studentName);

        // Fetch student's assigned mentor
        const { data: profile } = await supabaseAdmin
          .from('student_profiles')
          .select('mentor_id')
          .eq('id', studentId)
          .maybeSingle();

        // Determine sender (mentor or default admin)
        const senderId = profile?.mentor_id || adminUser?.id;

        if (!senderId) {
          // Cannot determine sender, cancel action
          await supabaseAdmin
            .from('pending_workflow_actions')
            .update({ status: 'CANCELLED' })
            .eq('id', action.id);
          continue;
        }

        // Get sender profile name
        const { data: senderUser } = await supabaseAdmin
          .from('users')
          .select('name')
          .eq('id', senderId)
          .maybeSingle();

        const senderName = senderUser?.name || 'Advisor';

        // Find or create conversation thread
        let conversationId = '';

        // Query direct message conversations
        const { data: conversationList } = await supabaseAdmin
          .from('conversations')
          .select('*')
          .eq('is_group', false)
          .contains('participant_ids', [studentId]);

        // Narrow down conversation containing BOTH participants
        const directConv = conversationList?.find(c => c.participant_ids.includes(senderId));

        if (directConv) {
          conversationId = directConv.id;
        } else {
          // Create new conversation
          const { data: newConv, error: cErr } = await supabaseAdmin
            .from('conversations')
            .insert({
              participant_ids: [studentId, senderId],
              is_group: false
            })
            .select()
            .single();

          if (!cErr && newConv) {
            conversationId = newConv.id;
          }
        }

        if (conversationId) {
          // Insert the message
          const { error: msgErr } = await supabaseAdmin
            .from('messages')
            .insert({
              conversation_id: conversationId,
              sender_id: senderId,
              text: formattedText,
              read_by: [senderId]
            });

          if (!msgErr) {
            // Send In-App Notification to student
            await supabaseAdmin
              .from('notifications')
              .insert({
                user_id: studentId,
                title: '💬 New Message',
                message: `${senderName}: ${formattedText.substring(0, 60)}${formattedText.length > 60 ? '...' : ''}`,
                type: 'INFO',
                category: 'NEW_MESSAGE',
                related_id: conversationId,
                is_read: false,
                created_by: senderId
              });

            // Mark action as completed
            await supabaseAdmin
              .from('pending_workflow_actions')
              .update({ status: 'COMPLETED' })
              .eq('id', action.id);

            executedCount++;
          }
        }
      }
    }

    res.json({
      message: 'Due pending actions processing completed',
      executedCount
    });
  } catch (error: any) {
    console.error('Execute due workflow actions error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

export const workflowsRouter = router;
