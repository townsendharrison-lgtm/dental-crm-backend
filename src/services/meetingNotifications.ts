import { supabaseAdmin } from '../config/supabase.js';
import { messaging } from '../config/firebase.js';

/** Meeting kinds (product model) */
export type MeetingAudience =
  | 'ADMIN_DIRECT' // 1. Admin ↔ specific student OR mentor
  | 'STUDENT' // 2. Mentor ↔ assigned student
  | 'MENTORS' // 3. All mentors + admin
  | 'STAFF' // 4. Mentor ↔ mentor manager (+ optional staff invites, no students)
  | 'GLOBAL'; // 5. Webinar — everyone; admin-only create

type MeetingRow = {
  id: string;
  title?: string | null;
  date: string;
  timezone?: string | null;
  mentor_id?: string | null;
  student_id?: string | null;
  attendees?: string[] | null;
  type?: string | null;
  audience?: MeetingAudience | string | null;
};

export function normalizeAudience(m: MeetingRow): MeetingAudience {
  const a = m.audience;
  if (
    a === 'ADMIN_DIRECT' ||
    a === 'STUDENT' ||
    a === 'MENTORS' ||
    a === 'STAFF' ||
    a === 'GLOBAL'
  ) {
    return a;
  }
  // Legacy
  if (a === 'CUSTOM') return 'STAFF';
  if (m.type === 'MANAGER_MEETING') return 'STAFF';
  if (m.type === 'GENERAL' && !m.student_id) return 'MENTORS';
  return 'STUDENT';
}

export function typeForAudience(audience: MeetingAudience): 'STUDENT_MEETING' | 'MANAGER_MEETING' | 'GENERAL' {
  switch (audience) {
    case 'STUDENT':
    case 'ADMIN_DIRECT':
      return 'STUDENT_MEETING';
    case 'STAFF':
      return 'MANAGER_MEETING';
    case 'MENTORS':
    case 'GLOBAL':
      return 'GENERAL';
  }
}

/** Mentor managers must not see/join these */
export function isHiddenFromMentorManager(audience: MeetingAudience) {
  return audience === 'ADMIN_DIRECT' || audience === 'MENTORS';
}

function formatMeetingWhen(dateIso: string, timezone?: string | null) {
  try {
    const d = new Date(dateIso);
    return d.toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: timezone || undefined,
    });
  } catch {
    return dateIso;
  }
}

function schedulePathForRole(role: string, meetingId: string) {
  const qs = `meetingId=${encodeURIComponent(meetingId)}`;
  switch (role) {
    case 'ADMIN':
      return `/admin/schedule?${qs}`;
    case 'MENTOR_MANAGER':
      return `/mentor-manager/schedule?${qs}`;
    case 'MENTOR':
      return `/mentor/schedule?${qs}`;
    case 'STUDENT':
      return `/student/momentum?${qs}`;
    default:
      return `/`;
  }
}

async function usersByRoles(roles: string[]) {
  const { data } = await supabaseAdmin.from('users').select('id').in('role', roles);
  return (data || []).map((u: { id: string }) => u.id);
}

async function resolveRecipientIds(meeting: MeetingRow, excludeUserId?: string) {
  const ids = new Set<string>();
  const audience = normalizeAudience(meeting);

  if (audience === 'MENTORS') {
    // All mentors + admins (not mentor managers — they can't see these)
    (await usersByRoles(['MENTOR', 'ADMIN'])).forEach((id) => ids.add(id));
  } else if (audience === 'GLOBAL') {
    (await usersByRoles(['STUDENT', 'MENTOR', 'MENTOR_MANAGER', 'ADMIN'])).forEach((id) => ids.add(id));
  } else {
    // ADMIN_DIRECT | STUDENT | STAFF — parties on the meeting
    if (meeting.mentor_id) ids.add(meeting.mentor_id);
    if (meeting.student_id) ids.add(meeting.student_id);
    (meeting.attendees || []).forEach((id) => {
      if (id) ids.add(id);
    });
  }

  if (excludeUserId) ids.delete(excludeUserId);
  return Array.from(ids);
}

async function sendPushToUsers(
  userIds: string[],
  payload: {
    title: string;
    body: string;
    meetingId: string;
    kind: string;
  },
) {
  if (!messaging || userIds.length === 0) return;

  const { data: users } = await supabaseAdmin
    .from('users')
    .select('id, role')
    .in('id', userIds);

  if (!users || users.length === 0) return;

  const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  const byRole = new Map<string, string[]>();
  for (const u of users as Array<{ id: string; role: string }>) {
    const list = byRole.get(u.role) || [];
    list.push(u.id);
    byRole.set(u.role, list);
  }

  for (const [role, roleUserIds] of byRole.entries()) {
    const { data: tokens } = await supabaseAdmin
      .from('fcm_tokens')
      .select('token')
      .in('user_id', roleUserIds);

    if (!tokens || tokens.length === 0) continue;

    const tokenStrings = tokens.map((t: { token: string }) => t.token);
    const path = schedulePathForRole(role, payload.meetingId);
    const link = `${frontendUrl}${path}`;

    try {
      const response = await messaging.sendEachForMulticast({
        tokens: tokenStrings,
        notification: {
          title: payload.title,
          body: payload.body.slice(0, 180),
        },
        webpush: {
          fcmOptions: { link },
        },
        data: {
          type: 'MEETING',
          meetingId: payload.meetingId,
          kind: payload.kind,
          link,
        },
      });

      if (response.failureCount > 0) {
        const invalidTokens: string[] = [];
        response.responses.forEach((r, idx) => {
          if (!r.success && r.error?.code === 'messaging/registration-token-not-registered') {
            invalidTokens.push(tokenStrings[idx]);
          }
        });
        if (invalidTokens.length > 0) {
          await supabaseAdmin.from('fcm_tokens').delete().in('token', invalidTokens);
        }
      }
    } catch (err) {
      console.error('Meeting FCM push error:', err);
    }
  }
}

export async function notifyMeetingParties(options: {
  meeting: MeetingRow;
  actorId: string;
  kind: 'created' | 'rescheduled' | 'cancelled';
}) {
  const { meeting, actorId, kind } = options;
  try {
    const recipients = await resolveRecipientIds(meeting, actorId);
    if (recipients.length === 0) return;

    const when = formatMeetingWhen(meeting.date, meeting.timezone);
    const title =
      kind === 'created'
        ? 'New Meeting Scheduled'
        : kind === 'rescheduled'
          ? 'Meeting Rescheduled'
          : 'Meeting Cancelled';
    const message =
      kind === 'cancelled'
        ? `"${meeting.title || 'Meeting'}" (${when}) was cancelled.`
        : kind === 'rescheduled'
          ? `"${meeting.title || 'Meeting'}" was moved to ${when}.`
          : `"${meeting.title || 'Meeting'}" is scheduled for ${when}.`;

    const rows = recipients.map((userId) => ({
      user_id: userId,
      title,
      message,
      type: kind === 'cancelled' ? ('WARNING' as const) : ('INFO' as const),
      category: 'MEETING',
      related_id: meeting.id,
      is_read: false,
      created_by: actorId,
    }));

    const { error } = await supabaseAdmin.from('notifications').insert(rows);
    if (error) {
      console.error('Failed to create meeting notifications:', error.message);
    }

    await sendPushToUsers(recipients, {
      title,
      body: message,
      meetingId: meeting.id,
      kind,
    });
  } catch (err) {
    console.error('notifyMeetingParties error:', err);
  }
}

/** Notify the meeting mentor that an admin/manager joined. */
export async function notifyMentorOfJoin(options: {
  meeting: MeetingRow;
  joinerId: string;
  joinerName: string;
}) {
  const { meeting, joinerId, joinerName } = options;
  const mentorId = meeting.mentor_id;
  if (!mentorId || mentorId === joinerId) return;

  try {
    const when = formatMeetingWhen(meeting.date, meeting.timezone);
    const title = 'Someone joined your meeting';
    const message = `${joinerName} added themselves to "${meeting.title || 'Meeting'}" (${when}).`;

    await supabaseAdmin.from('notifications').insert({
      user_id: mentorId,
      title,
      message,
      type: 'INFO',
      category: 'MEETING',
      related_id: meeting.id,
      is_read: false,
      created_by: joinerId,
    });

    await sendPushToUsers([mentorId], {
      title,
      body: message,
      meetingId: meeting.id,
      kind: 'joined',
    });
  } catch (err) {
    console.error('notifyMentorOfJoin error:', err);
  }
}

export function meetingScheduleFieldsChanged(
  existing: {
    date?: string;
    title?: string | null;
    timezone?: string | null;
    duration?: number | null;
    link?: string | null;
    student_id?: string | null;
    mentor_id?: string | null;
    attendees?: string[] | null;
    audience?: string | null;
  },
  updated: {
    date?: string;
    title?: string | null;
    timezone?: string | null;
    duration?: number | null;
    link?: string | null;
    student_id?: string | null;
    mentor_id?: string | null;
    attendees?: string[] | null;
    audience?: string | null;
  },
): boolean {
  const attendeesChanged =
    JSON.stringify([...(existing.attendees || [])].sort()) !==
    JSON.stringify([...(updated.attendees || [])].sort());

  return (
    existing.date !== updated.date ||
    (existing.title || '') !== (updated.title || '') ||
    (existing.timezone || '') !== (updated.timezone || '') ||
    Number(existing.duration || 0) !== Number(updated.duration || 0) ||
    (existing.link || '') !== (updated.link || '') ||
    (existing.student_id || '') !== (updated.student_id || '') ||
    (existing.mentor_id || '') !== (updated.mentor_id || '') ||
    (existing.audience || '') !== (updated.audience || '') ||
    attendeesChanged
  );
}
