import { Router, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import { handleApplicationStatusWorkflows } from '../services/workflowEngine.js';

const router = Router();

// All routes require authentication
router.use(authenticate);

// ─── GET /api/student-schools ────────────────────────────────────────
// Retrieve a student's school selections list (Reach, Target, Safety, status)
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { studentId } = req.query;

    let targetStudentId = userId;

    if (role !== 'STUDENT') {
      if (!studentId) {
        // If staff and no studentId is specified, query all selections they have access to
        if (role === 'MENTOR') {
          const { data: assigned } = await supabaseAdmin
            .from('student_profiles')
            .select('id')
            .eq('mentor_id', userId);
          const studentIds = assigned ? assigned.map(s => s.id) : [];

          const { data: selections, error } = await supabaseAdmin
            .from('student_schools')
            .select('*, school:schools(*)')
            .in('student_id', studentIds);

          if (error) return res.status(500).json({ error: error.message });
          return res.json({ selections: selections || [] });
        } else {
          // Admin / Mentor Manager sees all
          const { data: selections, error } = await supabaseAdmin
            .from('student_schools')
            .select('*, school:schools(*)');

          if (error) return res.status(500).json({ error: error.message });
          return res.json({ selections: selections || [] });
        }
      }
      targetStudentId = studentId as string;
    }

    // Verify access to studentId if caller is mentor
    if (role === 'MENTOR') {
      const { data: profile } = await supabaseAdmin
        .from('student_profiles')
        .select('mentor_id')
        .eq('id', targetStudentId)
        .maybeSingle();

      if (!profile || profile.mentor_id !== userId) {
        return res.status(403).json({ error: 'Access denied. Student is not assigned to you.' });
      }
    }

    const { data: selections, error } = await supabaseAdmin
      .from('student_schools')
      .select('*, school:schools(*)')
      .eq('student_id', targetStudentId);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ selections: selections || [] });
  } catch (error: any) {
    console.error('List student schools error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/student-schools ───────────────────────────────────────
// Add a school to a student's selections list
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const {
      studentId,
      schoolId,
      category,
      status = 'Interested',
      appliedDate,
      interviewDate,
      decisionDate,
      notes
    } = req.body;

    if (!schoolId || !category) {
      return res.status(400).json({ error: 'School ID and category (Reach, Target, Safety) are required' });
    }

    const targetStudentId = role === 'STUDENT' ? userId : studentId;

    if (!targetStudentId) {
      return res.status(400).json({ error: 'Student ID is required' });
    }

    // Verify assignment if Mentor is adding the school selection
    if (role === 'MENTOR') {
      const { data: profile } = await supabaseAdmin
        .from('student_profiles')
        .select('mentor_id')
        .eq('id', targetStudentId)
        .maybeSingle();

      if (!profile || profile.mentor_id !== userId) {
        return res.status(403).json({ error: 'You are not assigned to this student' });
      }
    }

    // Verify school exists
    const { data: school, error: sErr } = await supabaseAdmin
      .from('schools')
      .select('id')
      .eq('id', schoolId)
      .maybeSingle();

    if (sErr || !school) {
      return res.status(404).json({ error: 'School profile not found in directory' });
    }

    const { data: newSelection, error } = await supabaseAdmin
      .from('student_schools')
      .insert({
        student_id: targetStudentId,
        school_id: schoolId,
        category,
        status,
        applied_date: appliedDate || null,
        interview_date: interviewDate || null,
        decision_date: decisionDate || null,
        notes: notes || null
      })
      .select()
      .single();

    if (error) {
      // Handle uniqueness constraint violation
      if (error.code === '23505') {
        return res.status(400).json({ error: 'This school is already in the student\'s list' });
      }
      return res.status(400).json({ error: error.message });
    }

    void handleApplicationStatusWorkflows({
      studentId: targetStudentId,
      schoolId,
      previousStatus: null,
      newStatus: status,
      source: 'student_schools',
    });

    res.status(201).json(newSelection);
  } catch (error: any) {
    console.error('Create student school selection error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── PUT /api/student-schools/:id ────────────────────────────────────
// Update school selection details (status, category, dates, notes)
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { id } = req.params;
    const updates = req.body;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('student_schools')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Selection record not found' });
    }

    // Access check
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
    if (updates.category !== undefined) dbUpdates.category = updates.category;
    if (updates.status !== undefined) dbUpdates.status = updates.status;
    if (updates.appliedDate !== undefined) dbUpdates.applied_date = updates.appliedDate;
    if (updates.interviewDate !== undefined) dbUpdates.interview_date = updates.interviewDate;
    if (updates.decisionDate !== undefined) dbUpdates.decision_date = updates.decisionDate;
    if (updates.notes !== undefined) dbUpdates.notes = updates.notes;

    const { data: updated, error } = await supabaseAdmin
      .from('student_schools')
      .update(dbUpdates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    if (updates.status !== undefined && updates.status !== existing.status) {
      void handleApplicationStatusWorkflows({
        studentId: existing.student_id,
        schoolId: existing.school_id,
        previousStatus: existing.status,
        newStatus: updates.status,
        source: 'student_schools',
      });
    }

    res.json(updated);
  } catch (error: any) {
    console.error('Update student school selection error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── DELETE /api/student-schools/:id ─────────────────────────────────
// Remove a school from student selections list
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { id } = req.params;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('student_schools')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Selection record not found' });
    }

    // Access check
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
      .from('student_schools')
      .delete()
      .eq('id', id);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ message: 'School removed from student list successfully' });
  } catch (error: any) {
    console.error('Delete student school selection error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

export const studentSchoolsRouter = router;
