import { Router, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';

const router = Router();

// All routes require authentication
router.use(authenticate);

// ─── GET /api/experiences ────────────────────────────────────────────
// List student experiences (and nested hourly logs)
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { studentId } = req.query;

    let targetStudentId = userId;

    if (role !== 'STUDENT') {
      if (!studentId) {
        // If staff and no studentId is specified, query all experiences they have access to
        if (role === 'MENTOR') {
          const { data: assigned } = await supabaseAdmin
            .from('student_profiles')
            .select('id')
            .eq('mentor_id', userId);
          const studentIds = assigned ? assigned.map(s => s.id) : [];

          const { data: experiences, error } = await supabaseAdmin
            .from('experiences')
            .select('*, sessions:experience_sessions(*)')
            .in('student_id', studentIds)
            .order('start_date', { ascending: false });

          if (error) return res.status(500).json({ error: error.message });
          return res.json({ experiences: experiences || [] });
        } else {
          // Admin / Mentor Manager sees all
          const { data: experiences, error } = await supabaseAdmin
            .from('experiences')
            .select('*, sessions:experience_sessions(*)')
            .order('start_date', { ascending: false });

          if (error) return res.status(500).json({ error: error.message });
          return res.json({ experiences: experiences || [] });
        }
      }
      targetStudentId = studentId as string;
    }

    // Verify access to specific studentId if caller is mentor
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

    const { data: experiences, error } = await supabaseAdmin
      .from('experiences')
      .select('*, sessions:experience_sessions(*)')
      .eq('student_id', targetStudentId)
      .order('start_date', { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    // Sort nested sessions inside javascript to ensure descending chronological order
    const experiencesWithSortedSessions = (experiences || []).map(exp => {
      const sessions = exp.sessions ? [...exp.sessions].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()) : [];
      return { ...exp, sessions };
    });

    res.json({ experiences: experiencesWithSortedSessions });
  } catch (error: any) {
    console.error('List experiences error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── GET /api/experiences/:id ────────────────────────────────────────
// Get single experience profile with nested logged sessions
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { id } = req.params;

    const { data: experience, error } = await supabaseAdmin
      .from('experiences')
      .select('*, sessions:experience_sessions(*)')
      .eq('id', id)
      .maybeSingle();

    if (error || !experience) {
      return res.status(404).json({ error: 'Experience profile not found' });
    }

    // Access authorization check
    const isOwner = experience.student_id === userId;
    let isAssignedMentor = false;

    if (role === 'MENTOR') {
      const { data: profile } = await supabaseAdmin
        .from('student_profiles')
        .select('mentor_id')
        .eq('id', experience.student_id)
        .maybeSingle();
      isAssignedMentor = profile?.mentor_id === userId;
    }

    const isPrivileged = role === 'ADMIN' || role === 'MENTOR_MANAGER';

    if (!isOwner && !isAssignedMentor && !isPrivileged) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Sort nested sessions
    if (experience.sessions) {
      experience.sessions.sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());
    }

    res.json(experience);
  } catch (error: any) {
    console.error('Fetch experience details error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/experiences ───────────────────────────────────────────
// Create new experience profile
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const {
      studentId,
      category,
      title,
      organization,
      supervisorName,
      supervisorContact,
      description,
      startDate,
      endDate,
      isOngoing = false,
      dentistType
    } = req.body;

    if (!category || !title || !organization || !startDate) {
      return res.status(400).json({ error: 'Category, title, organization, and start date are required' });
    }

    const targetStudentId = role === 'STUDENT' ? userId : studentId;

    if (!targetStudentId) {
      return res.status(400).json({ error: 'Student ID is required' });
    }

    // Verify assignment if Mentor is creating the profile
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

    const { data: newExperience, error } = await supabaseAdmin
      .from('experiences')
      .insert({
        student_id: targetStudentId,
        category,
        title,
        organization,
        supervisor_name: supervisorName || null,
        supervisor_contact: supervisorContact || null,
        description: description || null,
        start_date: startDate,
        end_date: endDate || null,
        is_ongoing: isOngoing,
        dentist_type: dentistType || null
      })
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json(newExperience);
  } catch (error: any) {
    console.error('Create experience error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── PUT /api/experiences/:id ────────────────────────────────────────
// Update experience details
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { id } = req.params;
    const updates = req.body;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('experiences')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Experience profile not found' });
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
    if (updates.title !== undefined) dbUpdates.title = updates.title;
    if (updates.organization !== undefined) dbUpdates.organization = updates.organization;
    if (updates.supervisorName !== undefined) dbUpdates.supervisor_name = updates.supervisorName;
    if (updates.supervisorContact !== undefined) dbUpdates.supervisor_contact = updates.supervisorContact;
    if (updates.description !== undefined) dbUpdates.description = updates.description;
    if (updates.startDate !== undefined) dbUpdates.start_date = updates.startDate;
    if (updates.endDate !== undefined) dbUpdates.end_date = updates.endDate;
    if (updates.isOngoing !== undefined) dbUpdates.is_ongoing = updates.isOngoing;
    if (updates.dentistType !== undefined) dbUpdates.dentist_type = updates.dentistType;

    const { data: updated, error } = await supabaseAdmin
      .from('experiences')
      .update(dbUpdates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json(updated);
  } catch (error: any) {
    console.error('Update experience error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── DELETE /api/experiences/:id ─────────────────────────────────────
// Delete experience profile (cascade deletes sessions)
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { id } = req.params;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('experiences')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Experience profile not found' });
    }

    // Access checks
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
      .from('experiences')
      .delete()
      .eq('id', id);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ message: 'Experience profile deleted successfully' });
  } catch (error: any) {
    console.error('Delete experience error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/experiences/:experienceId/sessions ────────────────────
// Log a new session under an experience profile
router.post('/:experienceId/sessions', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { experienceId } = req.params;
    const { date, duration, notes } = req.body;

    if (!date || duration === undefined) {
      return res.status(400).json({ error: 'Date and duration are required' });
    }

    // Fetch parent experience profile
    const { data: exp, error: expErr } = await supabaseAdmin
      .from('experiences')
      .select('student_id')
      .eq('id', experienceId)
      .maybeSingle();

    if (expErr || !exp) {
      return res.status(404).json({ error: 'Experience profile not found' });
    }

    // Access check
    const isOwner = exp.student_id === userId;
    let isAssignedMentor = false;

    if (role === 'MENTOR') {
      const { data: profile } = await supabaseAdmin
        .from('student_profiles')
        .select('mentor_id')
        .eq('id', exp.student_id)
        .maybeSingle();
      isAssignedMentor = profile?.mentor_id === userId;
    }

    const isPrivileged = role === 'ADMIN' || role === 'MENTOR_MANAGER';

    if (!isOwner && !isAssignedMentor && !isPrivileged) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Insert logged session
    const { data: newSession, error } = await supabaseAdmin
      .from('experience_sessions')
      .insert({
        experience_id: experienceId,
        date,
        duration,
        notes: notes || null
      })
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json(newSession);
  } catch (error: any) {
    console.error('Create experience session error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── PUT /api/experiences/:experienceId/sessions/:sessionId ──────────
// Update a logged session
router.put('/:experienceId/sessions/:sessionId', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { experienceId, sessionId } = req.params;
    const updates = req.body;

    // Fetch parent experience profile
    const { data: exp, error: expErr } = await supabaseAdmin
      .from('experiences')
      .select('student_id')
      .eq('id', experienceId)
      .maybeSingle();

    if (expErr || !exp) {
      return res.status(404).json({ error: 'Experience profile not found' });
    }

    // Access check
    const isOwner = exp.student_id === userId;
    let isAssignedMentor = false;

    if (role === 'MENTOR') {
      const { data: profile } = await supabaseAdmin
        .from('student_profiles')
        .select('mentor_id')
        .eq('id', exp.student_id)
        .maybeSingle();
      isAssignedMentor = profile?.mentor_id === userId;
    }

    const isPrivileged = role === 'ADMIN' || role === 'MENTOR_MANAGER';

    if (!isOwner && !isAssignedMentor && !isPrivileged) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const dbUpdates: any = { updated_at: new Date().toISOString() };
    if (updates.date !== undefined) dbUpdates.date = updates.date;
    if (updates.duration !== undefined) dbUpdates.duration = updates.duration;
    if (updates.notes !== undefined) dbUpdates.notes = updates.notes;

    const { data: updatedSession, error } = await supabaseAdmin
      .from('experience_sessions')
      .update(dbUpdates)
      .eq('id', sessionId)
      .eq('experience_id', experienceId)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json(updatedSession);
  } catch (error: any) {
    console.error('Update experience session error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── DELETE /api/experiences/:experienceId/sessions/:sessionId ───────
// Delete a logged session
router.delete('/:experienceId/sessions/:sessionId', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { experienceId, sessionId } = req.params;

    // Fetch parent experience profile
    const { data: exp, error: expErr } = await supabaseAdmin
      .from('experiences')
      .select('student_id')
      .eq('id', experienceId)
      .maybeSingle();

    if (expErr || !exp) {
      return res.status(404).json({ error: 'Experience profile not found' });
    }

    // Access check
    const isOwner = exp.student_id === userId;
    let isAssignedMentor = false;

    if (role === 'MENTOR') {
      const { data: profile } = await supabaseAdmin
        .from('student_profiles')
        .select('mentor_id')
        .eq('id', exp.student_id)
        .maybeSingle();
      isAssignedMentor = profile?.mentor_id === userId;
    }

    const isPrivileged = role === 'ADMIN' || role === 'MENTOR_MANAGER';

    if (!isOwner && !isAssignedMentor && !isPrivileged) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { error } = await supabaseAdmin
      .from('experience_sessions')
      .delete()
      .eq('id', sessionId)
      .eq('experience_id', experienceId);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ message: 'Experience session deleted successfully' });
  } catch (error: any) {
    console.error('Delete experience session error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

export const experiencesRouter = router;
