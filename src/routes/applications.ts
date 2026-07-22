import { Router, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import { handleApplicationStatusWorkflows } from '../services/workflowEngine.js';

const router = Router();

// All routes require authentication
router.use(authenticate);

// ─── GET /api/applications ───────────────────────────────────────────
// List all application tracking records (joins school details)
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { studentId } = req.query;

    let targetStudentId = userId;

    if (role !== 'STUDENT') {
      if (!studentId) {
        // If staff and no studentId is specified, query all applications they have access to
        if (role === 'MENTOR') {
          const { data: assigned } = await supabaseAdmin
            .from('student_profiles')
            .select('id')
            .eq('mentor_id', userId);
          const studentIds = assigned ? assigned.map(s => s.id) : [];

          const { data: apps, error } = await supabaseAdmin
            .from('applications')
            .select('*, school:schools(*)')
            .in('student_id', studentIds);

          if (error) return res.status(500).json({ error: error.message });
          return res.json({ applications: apps || [] });
        } else {
          // Admin / Mentor Manager sees all
          const { data: apps, error } = await supabaseAdmin
            .from('applications')
            .select('*, school:schools(*)');

          if (error) return res.status(500).json({ error: error.message });
          return res.json({ applications: apps || [] });
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

    const { data: apps, error } = await supabaseAdmin
      .from('applications')
      .select('*, school:schools(*)')
      .eq('student_id', targetStudentId);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ applications: apps || [] });
  } catch (error: any) {
    console.error('List applications error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── GET /api/applications/:id ───────────────────────────────────────
// Get single application tracking details
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { id } = req.params;

    const { data: app, error } = await supabaseAdmin
      .from('applications')
      .select('*, school:schools(*)')
      .eq('id', id)
      .maybeSingle();

    if (error || !app) {
      return res.status(404).json({ error: 'Application record not found' });
    }

    // Access checks
    const isOwner = app.student_id === userId;
    let isAssignedMentor = false;

    if (role === 'MENTOR') {
      const { data: profile } = await supabaseAdmin
        .from('student_profiles')
        .select('mentor_id')
        .eq('id', app.student_id)
        .maybeSingle();
      isAssignedMentor = profile?.mentor_id === userId;
    }

    const isPrivileged = role === 'ADMIN' || role === 'MENTOR_MANAGER';

    if (!isOwner && !isAssignedMentor && !isPrivileged) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json(app);
  } catch (error: any) {
    console.error('Fetch application details error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/applications ──────────────────────────────────────────
// Log a new school application
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const {
      studentId,
      schoolId,
      status = 'Applied',
      appliedDate,
      interviewDate,
      decisionDate,
      notes,
    } = req.body;

    if (!schoolId) {
      return res.status(400).json({ error: 'School ID is required' });
    }

    const targetStudentId = role === 'STUDENT' ? userId : studentId;

    if (!targetStudentId) {
      return res.status(400).json({ error: 'Student ID is required' });
    }

    // Verify assignment if Mentor is adding the application
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

    const { data: newApp, error } = await supabaseAdmin
      .from('applications')
      .insert({
        student_id: targetStudentId,
        school_id: schoolId,
        status,
        applied_date: appliedDate || null,
        interview_date: interviewDate || null,
        decision_date: decisionDate || null,
        notes: notes || null,
      })
      .select('*, school:schools(*)')
      .single();

    if (error) {
      // Handle unique constraint violation
      if (error.code === '23505') {
        return res.status(400).json({ error: 'An application for this school has already been logged' });
      }
      return res.status(400).json({ error: error.message });
    }

    // Fire workflow automations for the initial status
    void handleApplicationStatusWorkflows({
      studentId: targetStudentId,
      schoolId,
      previousStatus: null,
      newStatus: status,
      source: 'applications',
    });

    res.status(201).json(newApp);
  } catch (error: any) {
    console.error('Create application error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── PUT /api/applications/:id ────────────────────────────────────────
// Update application tracking details (status, dates)
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { id } = req.params;
    const updates = req.body;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('applications')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Application record not found' });
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
    if (updates.status !== undefined) dbUpdates.status = updates.status;
    if (updates.appliedDate !== undefined) dbUpdates.applied_date = updates.appliedDate;
    if (updates.interviewDate !== undefined) dbUpdates.interview_date = updates.interviewDate;
    if (updates.decisionDate !== undefined) dbUpdates.decision_date = updates.decisionDate;
    if (updates.notes !== undefined) dbUpdates.notes = updates.notes;

    const { data: updated, error } = await supabaseAdmin
      .from('applications')
      .update(dbUpdates)
      .eq('id', id)
      .select('*, school:schools(*)')
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
        source: 'applications',
      });
    }

    res.json(updated);
  } catch (error: any) {
    console.error('Update application error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── DELETE /api/applications/:id ─────────────────────────────────────
// Delete application tracking record
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { id } = req.params;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('applications')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Application record not found' });
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
      .from('applications')
      .delete()
      .eq('id', id);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ message: 'Application tracking record deleted successfully' });
  } catch (error: any) {
    console.error('Delete application error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

export const applicationsRouter = router;
