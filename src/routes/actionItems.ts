import { Router, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';

const router = Router();

// All routes require authentication
router.use(authenticate);

// GET /api/action-items - List action items
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { studentId } = req.query; // optional filter

    let query = supabaseAdmin
      .from('action_items')
      .select('*')
      .order('due_date', { ascending: true });

    if (role === 'STUDENT') {
      query = query.eq('student_id', userId);
    } else if (role === 'MENTOR') {
      if (studentId) {
        // Verify mentor is assigned to studentId
        const { data: profile } = await supabaseAdmin
          .from('student_profiles')
          .select('mentor_id')
          .eq('id', studentId as string)
          .maybeSingle();

        if (!profile || profile.mentor_id !== userId) {
          return res.status(403).json({ error: 'You are not assigned to this student' });
        }
        query = query.eq('student_id', studentId as string);
      } else {
        // Query tasks of all assigned students
        const { data: assignedStudents } = await supabaseAdmin
          .from('student_profiles')
          .select('id')
          .eq('mentor_id', userId);

        const studentIds = assignedStudents ? assignedStudents.map(s => s.id) : [];
        query = query.in('student_id', studentIds);
      }
    } else {
      // Admin/Manager
      if (studentId) {
        query = query.eq('student_id', studentId as string);
      }
    }

    const { data: items, error } = await query;
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ actionItems: items || [] });
  } catch (error: any) {
    console.error('Fetch action items error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// GET /api/action-items/:id - Fetch single action item details
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { id } = req.params;

    const { data: item, error } = await supabaseAdmin
      .from('action_items')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error || !item) {
      return res.status(404).json({ error: 'Action item not found' });
    }

    // Access authorization
    const isOwner = item.student_id === userId;
    let isAssignedMentor = false;

    if (role === 'MENTOR') {
      const { data: profile } = await supabaseAdmin
        .from('student_profiles')
        .select('mentor_id')
        .eq('id', item.student_id)
        .maybeSingle();
      isAssignedMentor = profile?.mentor_id === userId;
    }

    const isPrivileged = role === 'ADMIN' || role === 'MENTOR_MANAGER';

    if (!isOwner && !isAssignedMentor && !isPrivileged) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json(item);
  } catch (error: any) {
    console.error('Fetch action item details error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// POST /api/action-items - Create a new action item
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const {
      studentId,
      meetingId,
      task,
      dueDate,
      priority = 'MEDIUM',
      description,
      category,
      resourceId,
      resourceLink
    } = req.body;

    if (!task || !dueDate) {
      return res.status(400).json({ error: 'Task and due date are required' });
    }

    // Set finalStudentId: Students default to themselves; Mentors/Admins specify studentId
    const finalStudentId = role === 'STUDENT' ? userId : studentId;

    if (!finalStudentId) {
      return res.status(400).json({ error: 'Student ID is required' });
    }

    // Verify assignment if Mentor is creating the task
    if (role === 'MENTOR') {
      const { data: profile } = await supabaseAdmin
        .from('student_profiles')
        .select('mentor_id')
        .eq('id', finalStudentId)
        .maybeSingle();

      if (!profile || profile.mentor_id !== userId) {
        return res.status(403).json({ error: 'You are not assigned to this student' });
      }
    }

    // Create action item
    const { data: newItem, error } = await supabaseAdmin
      .from('action_items')
      .insert({
        student_id: finalStudentId,
        meeting_id: meetingId || null,
        task,
        due_date: dueDate,
        priority,
        status: 'PENDING',
        description,
        category,
        resource_id: resourceId,
        resource_link: resourceLink
      })
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json(newItem);
  } catch (error: any) {
    console.error('Create action item error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// PUT /api/action-items/:id - Update an action item
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { id } = req.params;
    const updates = req.body;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('action_items')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Action item not found' });
    }

    // Authorization checks
    const isOwner = existing.student_id === userId;
    let isAssignedMentor = false;

    if (role === 'MENTOR') {
      const { data: profile } = await supabaseAdmin
        .from('student_profiles')
        .select('mentor_id')
        .eq('id', existing.student_id)
        .maybeSingle();
      isAssignedMentor = profile?.mentor_id === userId;
    }

    const isPrivileged = role === 'ADMIN' || role === 'MENTOR_MANAGER';

    if (!isOwner && !isAssignedMentor && !isPrivileged) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const dbUpdates: any = { updated_at: new Date().toISOString() };

    // Update permission filtering
    if (updates.status !== undefined) dbUpdates.status = updates.status;

    // Only allow details editing to Owner, Assigned Mentor, or Admins
    if (isOwner || isAssignedMentor || isPrivileged) {
      if (updates.task !== undefined) dbUpdates.task = updates.task;
      if (updates.due_date !== undefined) dbUpdates.due_date = updates.due_date;
      if (updates.priority !== undefined) dbUpdates.priority = updates.priority;
      if (updates.description !== undefined) dbUpdates.description = updates.description;
      if (updates.category !== undefined) dbUpdates.category = updates.category;
      if (updates.resource_id !== undefined) dbUpdates.resource_id = updates.resource_id;
      if (updates.resource_link !== undefined) dbUpdates.resource_link = updates.resource_link;
    }

    const { data: updatedItem, error } = await supabaseAdmin
      .from('action_items')
      .update(dbUpdates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json(updatedItem);
  } catch (error: any) {
    console.error('Update action item error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// DELETE /api/action-items/:id - Delete an action item
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { id } = req.params;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('action_items')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Action item not found' });
    }

    // Authorization checks: Only Owner, Assigned Mentor, or Admins can delete tasks
    const isOwner = existing.student_id === userId;
    let isAssignedMentor = false;

    if (role === 'MENTOR') {
      const { data: profile } = await supabaseAdmin
        .from('student_profiles')
        .select('mentor_id')
        .eq('id', existing.student_id)
        .maybeSingle();
      isAssignedMentor = profile?.mentor_id === userId;
    }

    const isPrivileged = role === 'ADMIN' || role === 'MENTOR_MANAGER';

    if (!isOwner && !isAssignedMentor && !isPrivileged) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { error } = await supabaseAdmin
      .from('action_items')
      .delete()
      .eq('id', id);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ message: 'Action item deleted successfully' });
  } catch (error: any) {
    console.error('Delete action item error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

export const actionItemsRouter = router;
