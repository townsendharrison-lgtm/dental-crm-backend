import { Router, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

function mapMilestone(row: any) {
  return {
    id: row.id,
    studentId: row.student_id,
    title: row.title,
    month: row.month,
    status: row.status,
    isCustom: row.is_custom,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function assertStudentAccess(requesterId: string, role: string, studentId: string) {
  if (role === 'STUDENT') {
    return requesterId === studentId;
  }
  if (role === 'ADMIN' || role === 'MENTOR_MANAGER') return true;
  if (role === 'MENTOR') {
    const { data: profile } = await supabaseAdmin
      .from('student_profiles')
      .select('mentor_id')
      .eq('id', studentId)
      .maybeSingle();
    return Boolean(profile && profile.mentor_id === requesterId);
  }
  return false;
}

// GET /api/milestones?studentId=
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const studentId = (req.query.studentId as string) || (role === 'STUDENT' ? userId : '');

    if (!studentId) {
      return res.status(400).json({ error: 'Student ID is required' });
    }

    if (!(await assertStudentAccess(userId, role, studentId))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { data, error } = await supabaseAdmin
      .from('student_milestones')
      .select('*')
      .eq('student_id', studentId)
      .order('month', { ascending: true })
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ milestones: (data || []).map(mapMilestone) });
  } catch (error: any) {
    console.error('List milestones error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// POST /api/milestones
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { studentId, title, month, status = 'Planned', isCustom = true, sortOrder } = req.body;

    const targetStudentId = role === 'STUDENT' ? userId : studentId;
    if (!targetStudentId) return res.status(400).json({ error: 'Student ID is required' });
    if (!title?.trim() || !month) {
      return res.status(400).json({ error: 'Title and month are required' });
    }
    if (!(await assertStudentAccess(userId, role, targetStudentId))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    let nextSort = Number(sortOrder);
    if (!Number.isFinite(nextSort)) {
      const { data: existing } = await supabaseAdmin
        .from('student_milestones')
        .select('sort_order')
        .eq('student_id', targetStudentId)
        .eq('month', month)
        .order('sort_order', { ascending: false })
        .limit(1);
      nextSort = existing?.[0]?.sort_order != null ? Number(existing[0].sort_order) + 1 : 0;
    }

    const { data, error } = await supabaseAdmin
      .from('student_milestones')
      .insert({
        student_id: targetStudentId,
        title: title.trim(),
        month,
        status: status === 'Completed' ? 'Completed' : 'Planned',
        is_custom: Boolean(isCustom),
        sort_order: nextSort,
      })
      .select('*')
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json(mapMilestone(data));
  } catch (error: any) {
    console.error('Create milestone error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// PUT /api/milestones/:id
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { id } = req.params;
    const { title, month, status, sortOrder, isCustom } = req.body;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('student_milestones')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Milestone not found' });
    }
    if (!(await assertStudentAccess(userId, role, existing.student_id))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (title !== undefined) updates.title = String(title).trim();
    if (month !== undefined) updates.month = month;
    if (status !== undefined) updates.status = status === 'Completed' ? 'Completed' : 'Planned';
    if (sortOrder !== undefined) updates.sort_order = Number(sortOrder) || 0;
    if (isCustom !== undefined) updates.is_custom = Boolean(isCustom);

    const { data, error } = await supabaseAdmin
      .from('student_milestones')
      .update(updates)
      .eq('id', id)
      .select('*')
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.json(mapMilestone(data));
  } catch (error: any) {
    console.error('Update milestone error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// PUT /api/milestones/bulk - reorder / move several at once
router.put('/bulk/sync', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { studentId, milestones } = req.body as {
      studentId?: string;
      milestones?: Array<{ id: string; month?: string; sortOrder?: number; status?: string; title?: string }>;
    };

    const targetStudentId = role === 'STUDENT' ? userId : studentId;
    if (!targetStudentId) return res.status(400).json({ error: 'Student ID is required' });
    if (!Array.isArray(milestones)) {
      return res.status(400).json({ error: 'milestones array is required' });
    }
    if (!(await assertStudentAccess(userId, role, targetStudentId))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const updated = [];
    for (const item of milestones) {
      if (!item?.id) continue;
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (item.month !== undefined) patch.month = item.month;
      if (item.sortOrder !== undefined) patch.sort_order = Number(item.sortOrder) || 0;
      if (item.status !== undefined) patch.status = item.status === 'Completed' ? 'Completed' : 'Planned';
      if (item.title !== undefined) patch.title = String(item.title).trim();

      const { data, error } = await supabaseAdmin
        .from('student_milestones')
        .update(patch)
        .eq('id', item.id)
        .eq('student_id', targetStudentId)
        .select('*')
        .maybeSingle();

      if (error) return res.status(400).json({ error: error.message });
      if (data) updated.push(mapMilestone(data));
    }

    res.json({ milestones: updated });
  } catch (error: any) {
    console.error('Bulk sync milestones error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// DELETE /api/milestones/:id
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { id } = req.params;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('student_milestones')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Milestone not found' });
    }
    if (!(await assertStudentAccess(userId, role, existing.student_id))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { error } = await supabaseAdmin.from('student_milestones').delete().eq('id', id);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ message: 'Milestone deleted' });
  } catch (error: any) {
    console.error('Delete milestone error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

export const milestonesRouter = router;
