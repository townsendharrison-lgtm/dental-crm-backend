import { Router, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';

const router = Router();

// All routes require authentication
router.use(authenticate);

// GET /api/staff-tasks - List staff tasks
// Admins see all tasks; Mentors and Managers see tasks assigned to them or created by them.
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;

    let query = supabaseAdmin
      .from('staff_tasks')
      .select('*')
      .order('due_date', { ascending: true });

    if (role !== 'ADMIN') {
      query = query.or(`assigned_to.eq.${userId},assigned_by.eq.${userId}`);
    }

    const { data: tasks, error } = await query;
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    if (!tasks || tasks.length === 0) {
      return res.json({ staffTasks: [] });
    }

    // Resolve user profile details (assignedTo, assignedBy, student context)
    const userIds = Array.from(
      new Set([
        ...tasks.map(t => t.assigned_to),
        ...tasks.map(t => t.assigned_by),
        ...tasks.map(t => t.student_id).filter(Boolean)
      ])
    );

    const { data: users } = await supabaseAdmin
      .from('users')
      .select('id, name, email, avatar, role')
      .in('id', userIds);

    const usersMap = new Map<string, any>();
    if (users) users.forEach(u => usersMap.set(u.id, u));

    const tasksWithDetails = tasks.map(t => ({
      ...t,
      assignedToUser: usersMap.get(t.assigned_to) || null,
      assignedByUser: usersMap.get(t.assigned_by) || null,
      studentUser: t.student_id ? usersMap.get(t.student_id) : null
    }));

    res.json({ staffTasks: tasksWithDetails });
  } catch (error: any) {
    console.error('Fetch staff tasks error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// GET /api/staff-tasks/:id - Fetch single staff task details
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { id } = req.params;

    const { data: task, error } = await supabaseAdmin
      .from('staff_tasks')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error || !task) {
      return res.status(404).json({ error: 'Staff task not found' });
    }

    // Access authorization: only assignee, creator, or Admin
    const isAssignee = task.assigned_to === userId;
    const isCreator = task.assigned_by === userId;
    const isAdmin = role === 'ADMIN';

    if (!isAssignee && !isCreator && !isAdmin) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Resolve users
    const userIds = [task.assigned_to, task.assigned_by];
    if (task.student_id) userIds.push(task.student_id);

    const { data: users } = await supabaseAdmin
      .from('users')
      .select('id, name, email, avatar, role')
      .in('id', userIds);

    const usersMap = new Map<string, any>();
    if (users) users.forEach(u => usersMap.set(u.id, u));

    res.json({
      ...task,
      assignedToUser: usersMap.get(task.assigned_to) || null,
      assignedByUser: usersMap.get(task.assigned_by) || null,
      studentUser: task.student_id ? usersMap.get(task.student_id) : null
    });
  } catch (error: any) {
    console.error('Fetch staff task details error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// POST /api/staff-tasks - Create a new staff task (Admin only)
router.post('/', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const {
      assignedTo,
      task,
      description,
      dueDate,
      priority = 'MEDIUM',
      relatedDocId,
      studentId
    } = req.body;

    if (!assignedTo || !task || !dueDate) {
      return res.status(400).json({ error: 'assignedTo, task, and dueDate are required' });
    }

    // Verify assignee exists
    const { data: assignee, error: aErr } = await supabaseAdmin
      .from('users')
      .select('id, role')
      .eq('id', assignedTo)
      .maybeSingle();

    if (aErr || !assignee) {
      return res.status(404).json({ error: 'Assignee user not found' });
    }

    if (assignee.role !== 'MENTOR' && assignee.role !== 'MENTOR_MANAGER') {
      return res.status(400).json({ error: 'Tasks can only be assigned to Mentors or Mentor Managers' });
    }

    const { data: newTask, error } = await supabaseAdmin
      .from('staff_tasks')
      .insert({
        assigned_to: assignedTo,
        assigned_by: userId,
        task,
        description,
        due_date: dueDate,
        priority,
        status: 'PENDING',
        related_doc_id: relatedDocId || null,
        student_id: studentId || null
      })
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json(newTask);
  } catch (error: any) {
    console.error('Create staff task error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// PUT /api/staff-tasks/:id - Update a staff task
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { id } = req.params;
    const updates = req.body;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('staff_tasks')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Staff task not found' });
    }

    // Authorization checks
    const isAssignee = existing.assigned_to === userId;
    const isAdmin = role === 'ADMIN';

    if (!isAssignee && !isAdmin) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const dbUpdates: any = { updated_at: new Date().toISOString() };

    // Standard staff can only update task status
    if (updates.status !== undefined) {
      dbUpdates.status = updates.status;
    }

    // Admin can update all fields
    if (isAdmin) {
      if (updates.assignedTo !== undefined) dbUpdates.assigned_to = updates.assignedTo;
      if (updates.task !== undefined) dbUpdates.task = updates.task;
      if (updates.description !== undefined) dbUpdates.description = updates.description;
      if (updates.dueDate !== undefined) dbUpdates.due_date = updates.dueDate;
      if (updates.priority !== undefined) dbUpdates.priority = updates.priority;
      if (updates.relatedDocId !== undefined) dbUpdates.related_doc_id = updates.relatedDocId;
      if (updates.studentId !== undefined) dbUpdates.student_id = updates.studentId;
    }

    const { data: updatedTask, error } = await supabaseAdmin
      .from('staff_tasks')
      .update(dbUpdates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json(updatedTask);
  } catch (error: any) {
    console.error('Update staff task error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// DELETE /api/staff-tasks/:id - Delete a staff task (Admin only)
router.delete('/:id', authorize('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('staff_tasks')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Staff task not found' });
    }

    const { error } = await supabaseAdmin
      .from('staff_tasks')
      .delete()
      .eq('id', id);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ message: 'Staff task deleted successfully' });
  } catch (error: any) {
    console.error('Delete staff task error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

export const staffTasksRouter = router;
