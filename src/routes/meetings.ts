import { Router, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import {
  notifyMeetingParties,
  notifyMentorOfJoin,
  meetingScheduleFieldsChanged,
  normalizeAudience,
  typeForAudience,
  isHiddenFromMentorManager,
  type MeetingAudience,
} from '../services/meetingNotifications.js';

const router = Router();
router.use(authenticate);

const VALID_AUDIENCES: MeetingAudience[] = [
  'ADMIN_DIRECT',
  'STUDENT',
  'MENTORS',
  'STAFF',
  'GLOBAL',
];

// ─── GET /api/meetings/invite-directory ───────────────────────────────
// Staff directory for invitee multi-select (mentors, managers, admins)
router.get('/invite-directory', async (req: AuthRequest, res: Response) => {
  try {
    const role = req.user!.role;
    if (role !== 'ADMIN' && role !== 'MENTOR_MANAGER' && role !== 'MENTOR') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { data, error } = await supabaseAdmin
      .from('users')
      .select('id, name, email, avatar, role')
      .in('role', ['MENTOR', 'MENTOR_MANAGER', 'ADMIN'])
      .order('name', { ascending: true });

    if (error) return res.status(400).json({ error: error.message });
    res.json({ users: data || [] });
  } catch (error: any) {
    console.error('Invite directory error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

function parseAudience(raw: unknown, fallback: MeetingAudience = 'STUDENT'): MeetingAudience {
  if (typeof raw === 'string' && VALID_AUDIENCES.includes(raw as MeetingAudience)) {
    return raw as MeetingAudience;
  }
  if (raw === 'CUSTOM') return 'STAFF';
  return fallback;
}

function canCreateAudience(role: string, audience: MeetingAudience): boolean {
  switch (audience) {
    case 'ADMIN_DIRECT':
    case 'MENTORS':
    case 'GLOBAL':
      return role === 'ADMIN';
    case 'STUDENT':
      return role === 'ADMIN' || role === 'MENTOR_MANAGER' || role === 'MENTOR';
    case 'STAFF':
      return role === 'ADMIN' || role === 'MENTOR_MANAGER' || role === 'MENTOR';
    default:
      return false;
  }
}

function canJoinAudience(role: string, audience: MeetingAudience): boolean {
  if (role === 'ADMIN') return true;
  if (role === 'MENTOR_MANAGER') {
    return audience === 'STUDENT' || audience === 'STAFF' || audience === 'GLOBAL';
  }
  return false;
}

/** Apply role-based list filters. Admin sees all (no filter). */
function applyListVisibility(
  query: any,
  role: string,
  userId: string,
) {
  if (role === 'ADMIN') return query;

  if (role === 'STUDENT') {
    // Own mentor meetings + global webinars only
    return query.or(`student_id.eq.${userId},audience.eq.GLOBAL`);
  }

  if (role === 'MENTOR') {
    return query.or(
      `mentor_id.eq.${userId},attendees.cs.{${userId}},audience.eq.MENTORS,audience.eq.GLOBAL`,
    );
  }

  if (role === 'MENTOR_MANAGER') {
    // Exclude #1 ADMIN_DIRECT and #3 MENTORS
    return query
      .neq('audience', 'ADMIN_DIRECT')
      .neq('audience', 'MENTORS');
  }

  return query;
}

function canViewMeeting(
  role: string,
  userId: string,
  meeting: { mentor_id?: string; student_id?: string | null; attendees?: string[] | null; audience?: string | null; type?: string | null },
) {
  const audience = normalizeAudience(meeting);
  if (role === 'ADMIN') return true;

  if (role === 'MENTOR_MANAGER') {
    if (isHiddenFromMentorManager(audience)) return false;
    return true; // they can see remaining meeting types on the schedule
  }

  if (role === 'MENTOR') {
    return (
      meeting.mentor_id === userId ||
      (meeting.attendees || []).includes(userId) ||
      audience === 'MENTORS' ||
      audience === 'GLOBAL'
    );
  }

  if (role === 'STUDENT') {
    return meeting.student_id === userId || audience === 'GLOBAL';
  }

  return false;
}

// ─── GET /api/meetings/calendar ───────────────────────────────────────
router.get('/calendar', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { start, end } = req.query;

    let meetingsQuery = supabaseAdmin.from('meetings').select('*');
    meetingsQuery = applyListVisibility(meetingsQuery, role, userId);

    if (start) meetingsQuery = meetingsQuery.gte('date', start as string);
    if (end) meetingsQuery = meetingsQuery.lte('date', end as string);

    const { data: meetings, error: mErr } = await meetingsQuery;
    if (mErr) return res.status(400).json({ error: mErr.message });

    let tasksQuery = supabaseAdmin.from('action_items').select('*');
    if (role === 'STUDENT') {
      tasksQuery = tasksQuery.eq('student_id', userId);
    } else if (role === 'MENTOR') {
      const { data: assignedStudents } = await supabaseAdmin
        .from('student_profiles')
        .select('id')
        .eq('mentor_id', userId);
      const studentIds = assignedStudents ? assignedStudents.map((s) => s.id) : [];
      tasksQuery = tasksQuery.in(
        'student_id',
        studentIds.length ? studentIds : ['00000000-0000-0000-0000-000000000000'],
      );
    }

    if (start) tasksQuery = tasksQuery.gte('due_date', start as string);
    if (end) tasksQuery = tasksQuery.lte('due_date', end as string);

    const { data: tasks, error: tErr } = await tasksQuery;
    if (tErr) return res.status(400).json({ error: tErr.message });

    const events: any[] = [];
    (meetings || []).forEach((m) => {
      events.push({
        id: m.id,
        title: m.title,
        date: m.date,
        type: m.type === 'MANAGER_MEETING' ? 'MANAGER_MEETING' : 'MEETING',
        mentorId: m.mentor_id,
        studentId: m.student_id || undefined,
        audience: normalizeAudience(m),
        status: m.completed ? 'completed' : 'scheduled',
      });
    });
    (tasks || []).forEach((t) => {
      events.push({
        id: t.id,
        title: `Task: ${t.task}`,
        date: t.due_date,
        type: 'TASK_DUE',
        studentId: t.student_id,
        status: t.status,
      });
    });

    res.json({ events });
  } catch (error: any) {
    console.error('Fetch calendar events error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── GET /api/meetings ───────────────────────────────────────────────
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;

    let query = supabaseAdmin.from('meetings').select('*').order('date', { ascending: true });
    query = applyListVisibility(query, role, userId);

    const { data: meetings, error } = await query;
    if (error) return res.status(400).json({ error: error.message });
    if (!meetings || meetings.length === 0) return res.json({ meetings: [] });

    const userIds = Array.from(
      new Set([
        ...meetings.map((m) => m.mentor_id),
        ...meetings.map((m) => m.student_id).filter(Boolean),
        ...meetings.flatMap((m) => m.attendees || []),
      ]),
    );

    const { data: users } = await supabaseAdmin
      .from('users')
      .select('id, name, email, avatar, role')
      .in('id', userIds);

    const usersMap = new Map<string, any>();
    if (users) users.forEach((u) => usersMap.set(u.id, u));

    const enriched = meetings.map((m) => {
      const base = {
        ...m,
        audience: normalizeAudience(m),
        mentor: usersMap.get(m.mentor_id) || null,
        student: m.student_id ? usersMap.get(m.student_id) : null,
        resolvedAttendees: (m.attendees || []).map((aId: string) => usersMap.get(aId)).filter(Boolean),
      };
      if (role === 'STUDENT') {
        delete (base as any).mentor_notes;
      }
      return base;
    });

    res.json({ meetings: enriched });
  } catch (error: any) {
    console.error('Fetch meetings error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── GET /api/meetings/:id ───────────────────────────────────────────
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

    if (error || !meeting) return res.status(404).json({ error: 'Meeting not found' });
    if (!canViewMeeting(role, userId, meeting)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const userIds = Array.from(
      new Set([meeting.mentor_id, meeting.student_id, ...(meeting.attendees || [])].filter(Boolean)),
    );
    const { data: users } = await supabaseAdmin
      .from('users')
      .select('id, name, email, avatar, role')
      .in('id', userIds);
    const usersMap = new Map<string, any>();
    if (users) users.forEach((u) => usersMap.set(u.id, u));

    if (role === 'STUDENT') delete meeting.mentor_notes;

    res.json({
      ...meeting,
      audience: normalizeAudience(meeting),
      mentor: usersMap.get(meeting.mentor_id) || null,
      student: meeting.student_id ? usersMap.get(meeting.student_id) : null,
      resolvedAttendees: (meeting.attendees || []).map((aId: string) => usersMap.get(aId)).filter(Boolean),
    });
  } catch (error: any) {
    console.error('Fetch meeting details error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/meetings/:id/attend ───────────────────────────────────
router.post('/:id/attend', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const { id } = req.params;

    if (role !== 'ADMIN' && role !== 'MENTOR_MANAGER') {
      return res.status(403).json({ error: 'Only admins and mentor managers can join meetings this way' });
    }

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('meetings')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) return res.status(404).json({ error: 'Meeting not found' });

    const audience = normalizeAudience(existing);
    if (!canJoinAudience(role, audience)) {
      return res.status(403).json({ error: 'You cannot join this type of meeting' });
    }

    const attendees: string[] = Array.isArray(existing.attendees) ? [...existing.attendees] : [];
    if (existing.mentor_id === userId || attendees.includes(userId)) {
      return res.json({ ...existing, audience });
    }

    attendees.push(userId);

    const { data: updated, error } = await supabaseAdmin
      .from('meetings')
      .update({ attendees, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    const { data: joiner } = await supabaseAdmin
      .from('users')
      .select('name, email')
      .eq('id', userId)
      .maybeSingle();
    const joinerName = joiner?.name || joiner?.email || req.user!.email || 'A staff member';

    void notifyMentorOfJoin({
      meeting: updated,
      joinerId: userId,
      joinerName,
    });

    res.json({ ...updated, audience: normalizeAudience(updated) });
  } catch (error: any) {
    console.error('Attend meeting error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── POST /api/meetings ──────────────────────────────────────────────
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;

    const {
      studentId,
      mentorId,
      title,
      date,
      timezone,
      duration,
      summary,
      notes,
      mentorNotes,
      type,
      audience: rawAudience,
      link,
      attendees = [],
      counterpartyType, // 'student' | 'mentor' for ADMIN_DIRECT
    } = req.body;

    if (!title || !date) {
      return res.status(400).json({ error: 'Title and date are required' });
    }

    const audience = parseAudience(
      rawAudience,
      type === 'MANAGER_MEETING' ? 'STAFF' : type === 'GENERAL' ? 'MENTORS' : 'STUDENT',
    );

    if (!canCreateAudience(role, audience)) {
      return res.status(403).json({ error: 'You cannot create this type of meeting' });
    }

    let finalMentorId = userId;
    let finalStudentId: string | null = null;
    let finalAttendees: string[] = Array.isArray(attendees) ? attendees.filter(Boolean) : [];

    if (audience === 'ADMIN_DIRECT') {
      // Admin 1:1 with a student OR a mentor
      if (counterpartyType === 'mentor' || (mentorId && !studentId)) {
        if (!mentorId) return res.status(400).json({ error: 'Select a mentor for this meeting' });
        finalMentorId = mentorId;
        finalStudentId = null;
        if (!finalAttendees.includes(userId)) finalAttendees = [...finalAttendees, userId];
      } else {
        if (!studentId) return res.status(400).json({ error: 'Select a student for this meeting' });
        finalMentorId = userId; // admin hosts
        finalStudentId = studentId;
      }
    } else if (audience === 'STUDENT') {
      if (!studentId) return res.status(400).json({ error: 'Student is required' });
      finalStudentId = studentId;
      finalMentorId =
        role === 'ADMIN' || role === 'MENTOR_MANAGER' ? mentorId || userId : userId;
      if (!finalMentorId) return res.status(400).json({ error: 'Mentor is required' });
    } else if (audience === 'MENTORS') {
      finalMentorId = userId; // admin organizes
      finalStudentId = null;
      finalAttendees = [];
    } else if (audience === 'STAFF') {
      // Mentor ↔ manager (+ optional staff). No students.
      finalStudentId = null;
      finalMentorId =
        role === 'MENTOR' ? userId : mentorId || userId;
      if (!finalMentorId) return res.status(400).json({ error: 'Select the mentor for this meeting' });
      if (finalAttendees.length === 0 && role === 'MENTOR') {
        return res.status(400).json({
          error: 'Invite at least one mentor manager (or other staff)',
        });
      }
      // Ensure creator is included if not the mentor host
      if (userId !== finalMentorId && !finalAttendees.includes(userId)) {
        finalAttendees = [...finalAttendees, userId];
      }
    } else if (audience === 'GLOBAL') {
      finalMentorId = userId;
      finalStudentId = null;
      finalAttendees = [];
    }

    const finalType = type || typeForAudience(audience);

    const { data: newMeeting, error } = await supabaseAdmin
      .from('meetings')
      .insert({
        student_id: finalStudentId,
        mentor_id: finalMentorId,
        title,
        date,
        timezone: timezone || 'UTC',
        duration: duration || 30,
        summary,
        notes,
        mentor_notes: mentorNotes,
        type: finalType,
        audience,
        link,
        attendees: finalAttendees,
        completed: false,
      })
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    void notifyMeetingParties({
      meeting: newMeeting,
      actorId: userId,
      kind: 'created',
    });

    res.status(201).json({ ...newMeeting, audience: normalizeAudience(newMeeting) });
  } catch (error: any) {
    console.error('Schedule meeting error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── PUT /api/meetings/:id ───────────────────────────────────────────
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

    if (fetchErr || !existing) return res.status(404).json({ error: 'Meeting not found' });

    const isOrganizer = existing.mentor_id === userId || (existing.attendees || []).includes(userId);
    const isPrivileged = role === 'ADMIN' || role === 'MENTOR_MANAGER';
    const audience = normalizeAudience(existing);

    if (role === 'MENTOR_MANAGER' && isHiddenFromMentorManager(audience)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (role === 'STUDENT' && existing.student_id !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const dbUpdates: any = { updated_at: new Date().toISOString() };

    if ((isOrganizer || isPrivileged) && role !== 'STUDENT') {
      if (updates.title !== undefined) dbUpdates.title = updates.title;
      if (updates.date !== undefined) dbUpdates.date = updates.date;
      if (updates.timezone !== undefined) dbUpdates.timezone = updates.timezone;
      if (updates.duration !== undefined) dbUpdates.duration = updates.duration;
      if (updates.summary !== undefined) dbUpdates.summary = updates.summary;
      if (updates.notes !== undefined) dbUpdates.notes = updates.notes;
      if (updates.mentorNotes !== undefined) dbUpdates.mentor_notes = updates.mentorNotes;
      if (updates.mentor_notes !== undefined) dbUpdates.mentor_notes = updates.mentor_notes;
      if (updates.link !== undefined) dbUpdates.link = updates.link;
      if (updates.completed !== undefined) dbUpdates.completed = updates.completed;
      if (updates.attendees !== undefined) dbUpdates.attendees = updates.attendees;

      if (updates.audience !== undefined) {
        const nextAudience = parseAudience(updates.audience, audience);
        if (!canCreateAudience(role, nextAudience) && nextAudience !== audience) {
          return res.status(403).json({ error: 'You cannot change to this meeting type' });
        }
        dbUpdates.audience = nextAudience;
        dbUpdates.type = updates.type || typeForAudience(nextAudience);
        if (nextAudience === 'MENTORS' || nextAudience === 'GLOBAL' || nextAudience === 'STAFF') {
          if (nextAudience !== 'STUDENT' && nextAudience !== 'ADMIN_DIRECT') {
            // STAFF and broadcasts have no student
            if (nextAudience !== 'ADMIN_DIRECT') dbUpdates.student_id = null;
          }
          if (nextAudience === 'MENTORS' || nextAudience === 'GLOBAL' || nextAudience === 'STAFF') {
            dbUpdates.student_id = null;
          }
        }
      } else if (updates.type !== undefined) {
        dbUpdates.type = updates.type;
      }

      if (isPrivileged || existing.mentor_id === userId) {
        if (updates.studentId !== undefined) dbUpdates.student_id = updates.studentId || null;
        if (updates.student_id !== undefined) dbUpdates.student_id = updates.student_id;
        if (isPrivileged && updates.mentorId !== undefined) dbUpdates.mentor_id = updates.mentorId;
        if (isPrivileged && updates.mentor_id !== undefined) dbUpdates.mentor_id = updates.mentor_id;
      }
    } else if (role === 'STUDENT' && existing.student_id === userId) {
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

    if (error) return res.status(500).json({ error: error.message });

    if (role !== 'STUDENT' && meetingScheduleFieldsChanged(existing, updated)) {
      void notifyMeetingParties({
        meeting: updated,
        actorId: userId,
        kind: 'rescheduled',
      });
    }

    res.json({ ...updated, audience: normalizeAudience(updated) });
  } catch (error: any) {
    console.error('Update meeting error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ─── DELETE /api/meetings/:id ────────────────────────────────────────
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

    if (fetchErr || !existing) return res.status(404).json({ error: 'Meeting not found' });

    const audience = normalizeAudience(existing);
    if (role === 'MENTOR_MANAGER' && isHiddenFromMentorManager(audience)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const isOrganizer = existing.mentor_id === userId;
    const isPrivileged = role === 'ADMIN' || role === 'MENTOR_MANAGER';
    if (!isOrganizer && !isPrivileged) {
      return res.status(403).json({ error: 'You do not have permission to delete this meeting' });
    }

    const { error } = await supabaseAdmin.from('meetings').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });

    void notifyMeetingParties({
      meeting: existing,
      actorId: userId,
      kind: 'cancelled',
    });

    res.json({ message: 'Meeting cancelled successfully' });
  } catch (error: any) {
    console.error('Delete meeting error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

export const meetingsRouter = router;
