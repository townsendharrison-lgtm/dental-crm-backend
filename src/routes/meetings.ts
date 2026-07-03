import { Router, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';

const router = Router();

// All routes require authentication
router.use(authenticate);

// ─── GET /api/meetings/calendar ───────────────────────────────────────
// Get unified calendar events (Meetings + Action Items due dates)
router.get('/calendar', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { start, end } = req.query; // Date strings

    // 1. Query meetings
    let meetingsQuery = supabaseAdmin.from('meetings').select('*');
    if (role === 'STUDENT') {
      meetingsQuery = meetingsQuery.eq('student_id', userId);
    } else if (role === 'MENTOR') {
      meetingsQuery = meetingsQuery.or(`mentor_id.eq.${userId},attendees.cs.{${userId}}`);
    }

    if (start) meetingsQuery = meetingsQuery.gte('date', start as string);
    if (end) meetingsQuery = meetingsQuery.lte('date', end as string);

    const { data: meetings, error: mErr } = await meetingsQuery;
    if (mErr) return res.status(400).json({ error: mErr.message });

    // 2. Query action items
    let tasksQuery = supabaseAdmin.from('action_items').select('*');
    if (role === 'STUDENT') {
      tasksQuery = tasksQuery.eq('student_id', userId);
    } else if (role === 'MENTOR') {
      // Find tasks of students assigned to this mentor
      const { data: assignedStudents } = await supabaseAdmin
        .from('student_profiles')
        .select('id')
        .eq('mentor_id', userId);
      const studentIds = assignedStudents ? assignedStudents.map(s => s.id) : [];
      tasksQuery = tasksQuery.in('student_id', studentIds);
    }

    if (start) tasksQuery = tasksQuery.gte('due_date', start as string);
    if (end) tasksQuery = tasksQuery.lte('due_date', end as string);

    const { data: tasks, error: tErr } = await tasksQuery;
    if (tErr) return res.status(400).json({ error: tErr.message });

    // 3. Aggregate into CalendarEvent format
    const events: any[] = [];

    if (meetings) {
      meetings.forEach(m => {
        events.push({
          id: m.id,
          title: m.title,
          date: m.date,
          type: m.type === 'MANAGER_MEETING' ? 'MANAGER_MEETING' : 'MEETING',
          mentorId: m.mentor_id,
          studentId: m.student_id || undefined,
          status: m.completed ? 'completed' : 'scheduled'
        });
      });
    }

    if (tasks) {
      tasks.forEach(t => {
        events.push({
          id: t.id,
          title: `Task: ${t.task}`,
          date: t.due_date,
          type: 'TASK_DUE',
          studentId: t.student_id,
          status: t.status
        });
      });
    }

    res.json({ events });
  } catch (error: any) {
    console.error('Fetch calendar events error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── GET /api/meetings ───────────────────────────────────────────────
// List all meetings for the current user
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;

    let query = supabaseAdmin
      .from('meetings')
      .select('*')
      .order('date', { ascending: true });

    if (role === 'STUDENT') {
      query = query.eq('student_id', userId);
    } else if (role === 'MENTOR') {
      query = query.or(`mentor_id.eq.${userId},attendees.cs.{${userId}}`);
    }

    const { data: meetings, error } = await query;
    if (error) return res.status(400).json({ error: error.message });

    if (!meetings || meetings.length === 0) {
      return res.json({ meetings: [] });
    }

    // Resolve attendee details (users)
    const userIds = Array.from(
      new Set([
        ...meetings.map(m => m.mentor_id),
        ...meetings.map(m => m.student_id).filter(Boolean),
        ...meetings.flatMap(m => m.attendees || [])
      ])
    );

    const { data: users } = await supabaseAdmin
      .from('users')
      .select('id, name, email, avatar, role')
      .in('id', userIds);

    const usersMap = new Map<string, any>();
    if (users) users.forEach(u => usersMap.set(u.id, u));

    const meetingsWithUsers = meetings.map(m => ({
      ...m,
      mentor: usersMap.get(m.mentor_id) || null,
      student: m.student_id ? usersMap.get(m.student_id) : null,
      resolvedAttendees: (m.attendees || []).map((aId: string) => usersMap.get(aId)).filter(Boolean)
    }));

    res.json({ meetings: meetingsWithUsers });
  } catch (error: any) {
    console.error('Fetch meetings error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── GET /api/meetings/:id ───────────────────────────────────────────
// Get detailed meeting by ID
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { id } = req.params;

    const { data: meeting, error } = await supabaseAdmin
      .from('meetings')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error || !meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }

    // Auth check
    const isParticipant =
      meeting.student_id === userId ||
      meeting.mentor_id === userId ||
      (meeting.attendees || []).includes(userId);

    const isPrivileged = role === 'ADMIN' || role === 'MENTOR_MANAGER';

    if (!isParticipant && !isPrivileged) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Resolve users
    const userIds = [meeting.mentor_id];
    if (meeting.student_id) userIds.push(meeting.student_id);
    if (meeting.attendees) userIds.push(...meeting.attendees);

    const { data: users } = await supabaseAdmin
      .from('users')
      .select('id, name, email, avatar, role')
      .in('id', userIds);

    const usersMap = new Map<string, any>();
    if (users) users.forEach(u => usersMap.set(u.id, u));

    // Hide mentor private notes from students
    if (role === 'STUDENT') {
      delete meeting.mentor_notes;
    }

    res.json({
      ...meeting,
      mentor: usersMap.get(meeting.mentor_id) || null,
      student: meeting.student_id ? usersMap.get(meeting.student_id) : null,
      resolvedAttendees: (meeting.attendees || []).map((aId: string) => usersMap.get(aId)).filter(Boolean)
    });
  } catch (error: any) {
    console.error('Fetch meeting details error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/meetings ──────────────────────────────────────────────
// Schedule a new meeting
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;

    const {
      studentId,
      mentorId, // optional for Admins/Managers to set, otherwise defaults to current user
      title,
      date,
      timezone,
      duration,
      summary,
      notes,
      mentorNotes,
      type = 'STUDENT_MEETING',
      link,
      attendees = []
    } = req.body;

    if (!title || !date) {
      return res.status(400).json({ error: 'Title and date are required' });
    }

    // Set mentorId: Admins/Managers can set scheduling mentor; Mentors default to themselves
    const finalMentorId = (role === 'ADMIN' || role === 'MENTOR_MANAGER') ? (mentorId || userId) : userId;

    const { data: newMeeting, error } = await supabaseAdmin
      .from('meetings')
      .insert({
        student_id: studentId || null,
        mentor_id: finalMentorId,
        title,
        date,
        timezone: timezone || 'UTC',
        duration: duration || 30,
        summary,
        notes,
        mentor_notes: mentorNotes,
        type,
        link,
        attendees,
        completed: false
      })
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json(newMeeting);
  } catch (error: any) {
    console.error('Schedule meeting error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── PUT /api/meetings/:id ───────────────────────────────────────────
// Edit a meeting or mark as completed
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { id } = req.params;
    const updates = req.body;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('meetings')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Meeting not found' });
    }

    // Authorization check
    const isOrganizer = existing.mentor_id === userId;
    const isPrivileged = role === 'ADMIN' || role === 'MENTOR_MANAGER';

    // Allow students to only edit basic notes/summary or nothing at all
    if (role === 'STUDENT' && existing.student_id !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const dbUpdates: any = { updated_at: new Date().toISOString() };

    if (isOrganizer || isPrivileged) {
      // Full editing permissions
      if (updates.title !== undefined) dbUpdates.title = updates.title;
      if (updates.date !== undefined) dbUpdates.date = updates.date;
      if (updates.timezone !== undefined) dbUpdates.timezone = updates.timezone;
      if (updates.duration !== undefined) dbUpdates.duration = updates.duration;
      if (updates.summary !== undefined) dbUpdates.summary = updates.summary;
      if (updates.notes !== undefined) dbUpdates.notes = updates.notes;
      if (updates.mentor_notes !== undefined) dbUpdates.mentor_notes = updates.mentor_notes;
      if (updates.type !== undefined) dbUpdates.type = updates.type;
      if (updates.link !== undefined) dbUpdates.link = updates.link;
      if (updates.completed !== undefined) dbUpdates.completed = updates.completed;
      if (updates.attendees !== undefined) dbUpdates.attendees = updates.attendees;
    } else if (role === 'STUDENT' && existing.student_id === userId) {
      // Students can only write to notes
      if (updates.notes !== undefined) dbUpdates.notes = updates.notes;
    } else {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { data: updated, error } = await supabaseAdmin
      .from('meetings')
      .update(dbUpdates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json(updated);
  } catch (error: any) {
    console.error('Update meeting error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── DELETE /api/meetings/:id ────────────────────────────────────────
// Cancel / Delete a scheduled meeting
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { id } = req.params;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('meetings')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Meeting not found' });
    }

    // Only organizers (mentor_id) or Admin/Managers can delete meetings
    const isOrganizer = existing.mentor_id === userId;
    const isPrivileged = role === 'ADMIN' || role === 'MENTOR_MANAGER';

    if (!isOrganizer && !isPrivileged) {
      return res.status(403).json({ error: 'You do not have permission to delete this meeting' });
    }

    const { error } = await supabaseAdmin
      .from('meetings')
      .delete()
      .eq('id', id);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ message: 'Meeting cancelled successfully' });
  } catch (error: any) {
    console.error('Delete meeting error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

export const meetingsRouter = router;
