import { supabaseAdmin } from '../config/supabase.js';
import { messaging } from '../config/firebase.js';

/** Meeting kinds (product model) */
export type MeetingAudience =
  | 'ADMIN_DIRECT' // 1. Admin ↔ specific student OR mentor
  | 'STUDENT' // 2. Mentor ↔ assigned student
  | 'MENTORS' // 3. All mentors + admin
  | 'STAFF' // 4. Mentor ↔ mentor manager (+ optional staff invites, no students)
  | 'GLOBAL'; // 5. Webinar — everyone; admin-only create

export type MeetingRow = {
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

/** Fields actually read by normalizeAudience (id/date not required). */
export type MeetingAudienceSource = Pick<
  MeetingRow,
  'audience' | 'type' | 'student_id'
>;

export function normalizeAudience(m: MeetingAudienceSource): MeetingAudience {
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
      timeZone: timezone || 'UTC',
      timeZoneName: 'short',
    });
  } catch {
    return dateIso;
  }
}

/** Prefer each recipient's profile timezone so notification copy matches their clock. */
async function timezonesForUsers(userIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (userIds.length === 0) return map;
  const { data } = await supabaseAdmin
    .from('student_profiles')
    .select('id, timezone')
    .in('id', userIds);
  for (const row of data || []) {
    if (row.timezone) map.set(row.id, row.timezone);
  }
  return map;
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

export async function sendPushToUsers(
  userIds: string[],
  payload: {
    title: string;
    body: string;
    meetingId: string;
    kind: string;
    /** Overrides the default schedule deep link. */
    linkPath?: string;
    /** FCM data.type. Defaults to MEETING. */
    dataType?: string;
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
    const path = payload.linkPath || schedulePathForRole(role, payload.meetingId);
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
          type: payload.dataType || 'MEETING',
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

/** 15-minute heads-up for everyone involved (no actor excluded). */
export async function notifyMeetingStartingSoon(options: { meeting: MeetingRow }) {
  const { meeting } = options;
  try {
    const recipients = await resolveRecipientIds(meeting);
    if (recipients.length === 0) return;

    const audience = normalizeAudience(meeting);
    const label =
      audience === 'GLOBAL'
        ? meeting.title || 'Webinar'
        : meeting.title || 'Meeting';
    const title =
      audience === 'GLOBAL' ? 'Webinar starting in 15 minutes' : 'Meeting starting in 15 minutes';
    const message = `"${label}" starts in 15 minutes. Join when you're ready.`;

    const rows = recipients.map((userId) => ({
      user_id: userId,
      title,
      message,
      type: 'INFO' as const,
      category: 'MEETING',
      related_id: meeting.id,
      is_read: false,
      created_by: 'system',
    }));

    const { error } = await supabaseAdmin.from('notifications').insert(rows);
    if (error) {
      console.error('Failed to create meeting reminder notifications:', error.message);
    }

    await sendPushToUsers(recipients, {
      title,
      body: message,
      meetingId: meeting.id,
      kind: 'reminder_15',
    });
  } catch (err) {
    console.error('notifyMeetingStartingSoon error:', err);
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

    const tzByUser = await timezonesForUsers(recipients);
    const fallbackTz = meeting.timezone || 'UTC';
    const title =
      kind === 'created'
        ? 'New Meeting Scheduled'
        : kind === 'rescheduled'
          ? 'Meeting Rescheduled'
          : 'Meeting Cancelled';

    const rows = recipients.map((userId) => {
      const when = formatMeetingWhen(meeting.date, tzByUser.get(userId) || fallbackTz);
      const message =
        kind === 'cancelled'
          ? `"${meeting.title || 'Meeting'}" (${when}) was cancelled.`
          : kind === 'rescheduled'
            ? `"${meeting.title || 'Meeting'}" was moved to ${when}.`
            : `"${meeting.title || 'Meeting'}" is scheduled for ${when}.`;
      return {
        user_id: userId,
        title,
        message,
        type: kind === 'cancelled' ? ('WARNING' as const) : ('INFO' as const),
        category: 'MEETING',
        related_id: meeting.id,
        is_read: false,
        created_by: actorId,
      };
    });

    const { error } = await supabaseAdmin.from('notifications').insert(rows);
    if (error) {
      console.error('Failed to create meeting notifications:', error.message);
    }

    // Push body uses meeting timezone (one payload); in-app rows are per-user.
    const pushWhen = formatMeetingWhen(meeting.date, fallbackTz);
    const pushBody =
      kind === 'cancelled'
        ? `"${meeting.title || 'Meeting'}" (${pushWhen}) was cancelled.`
        : kind === 'rescheduled'
          ? `"${meeting.title || 'Meeting'}" was moved to ${pushWhen}.`
          : `"${meeting.title || 'Meeting'}" is scheduled for ${pushWhen}.`;

    await sendPushToUsers(recipients, {
      title,
      body: pushBody,
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
    const tzByUser = await timezonesForUsers([mentorId]);
    const when = formatMeetingWhen(
      meeting.date,
      tzByUser.get(mentorId) || meeting.timezone || 'UTC',
    );
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

export const MEETING_NOTES_READY_CATEGORY = 'MEETING_NOTES_READY';
export const MEETING_COMPLETE_SNOOZE_CATEGORY = 'MEETING_COMPLETE_SNOOZE';
export const MEETING_COMPLETE_REMINDER_CATEGORY = 'MEETING_COMPLETE_REMINDER';

const COMPLETE_PROMPT_REMINDER_MS = 24 * 60 * 60 * 1000;

function completeMeetingPath(meetingId: string) {
  return `/mentor/command-center?completeMeeting=${encodeURIComponent(meetingId)}`;
}

async function personName(userId?: string | null) {
  if (!userId) return '';
  const { data } = await supabaseAdmin.from('users').select('name').eq('id', userId).maybeSingle();
  return String(data?.name || '').trim();
}

async function insertMeetingNotice(row: {
  userId: string;
  title: string;
  message: string;
  category: string;
  meetingId: string;
  type?: 'INFO' | 'WARNING' | 'URGENT';
}) {
  const { error } = await supabaseAdmin.from('notifications').insert({
    user_id: row.userId,
    title: row.title,
    message: row.message,
    type: row.type || 'INFO',
    category: row.category,
    related_id: row.meetingId,
    is_read: false,
    created_by: 'system',
  });
  if (error) console.error(`Meeting notice insert failed (${row.category}):`, error.message);
}

/** First push + in-app alert once Gemini notes are saved and the meeting is still open. */
export async function notifyMentorGeminiNotesReady(meeting: {
  id: string;
  title?: string | null;
  mentor_id?: string | null;
  student_id?: string | null;
  completed?: boolean | null;
}) {
  try {
    if (meeting.completed) return;
    const mentorId = meeting.mentor_id;
    if (!mentorId) return;

    const { data: existing } = await supabaseAdmin
      .from('notifications')
      .select('id')
      .eq('user_id', mentorId)
      .eq('category', MEETING_NOTES_READY_CATEGORY)
      .eq('related_id', meeting.id)
      .limit(1);
    if (existing && existing.length > 0) return;

    const student = (await personName(meeting.student_id)) || 'your student';
    const title = 'Gemini notes are ready';
    const message = `Notes for your meeting with ${student} are ready. Open your dashboard to complete it.`;

    await insertMeetingNotice({
      userId: mentorId,
      title,
      message,
      category: MEETING_NOTES_READY_CATEGORY,
      meetingId: meeting.id,
      type: 'WARNING',
    });
    await sendPushToUsers([mentorId], {
      title,
      body: message,
      meetingId: meeting.id,
      kind: 'notes_ready',
      linkPath: completeMeetingPath(meeting.id),
    });
  } catch (err) {
    console.error('notifyMentorGeminiNotesReady error:', err);
  }
}

/** Mentor closed the complete-meeting prompt. The 24-hour reminder clock starts here. */
export async function snoozeMeetingCompletePrompt(meetingId: string, mentorId: string) {
  await supabaseAdmin
    .from('notifications')
    .delete()
    .eq('user_id', mentorId)
    .eq('category', MEETING_COMPLETE_SNOOZE_CATEGORY)
    .eq('related_id', meetingId);

  await insertMeetingNotice({
    userId: mentorId,
    title: 'Meeting completion postponed',
    message: 'The mentor closed the complete-meeting prompt.',
    category: MEETING_COMPLETE_SNOOZE_CATEGORY,
    meetingId,
  });
}

/**
 * After the mentor dismisses the prompt, push again every 24 hours until the meeting is completed.
 */
export async function remindMentorsToCompleteNotedMeetings() {
  const { data: meetings, error } = await supabaseAdmin
    .from('meetings')
    .select('id, title, mentor_id, student_id, completed, meet_status')
    .eq('completed', false)
    .eq('meet_status', 'notes_ready')
    .not('mentor_id', 'is', null)
    .limit(100);

  if (error) {
    console.error('Complete-meeting reminder fetch error:', error.message);
    return;
  }
  if (!meetings || meetings.length === 0) return;

  const ids = meetings.map((m) => m.id);
  const { data: markers, error: markerError } = await supabaseAdmin
    .from('notifications')
    .select('user_id, related_id, category, created_at')
    .in('related_id', ids)
    .in('category', [MEETING_COMPLETE_SNOOZE_CATEGORY, MEETING_COMPLETE_REMINDER_CATEGORY]);

  if (markerError) {
    console.error('Complete-meeting reminder marker error:', markerError.message);
    return;
  }

  const now = Date.now();
  let sent = 0;
  for (const meeting of meetings) {
    const mentorId = meeting.mentor_id as string;
    const rows = (markers || []).filter(
      (row) => row.related_id === meeting.id && row.user_id === mentorId,
    );
    const snoozeAt = latestTime(rows, MEETING_COMPLETE_SNOOZE_CATEGORY);
    if (!snoozeAt) continue;
    const reminderAt = latestTime(rows, MEETING_COMPLETE_REMINDER_CATEGORY);
    const anchor = Math.max(snoozeAt, reminderAt || 0);
    if (now - anchor < COMPLETE_PROMPT_REMINDER_MS) continue;

    const student = (await personName(meeting.student_id)) || 'your student';
    const title = 'Meeting still needs to be completed';
    const message = `Gemini notes for your meeting with ${student} are ready. Complete it from your dashboard.`;
    await insertMeetingNotice({
      userId: mentorId,
      title,
      message,
      category: MEETING_COMPLETE_REMINDER_CATEGORY,
      meetingId: meeting.id,
      type: 'WARNING',
    });
    await sendPushToUsers([mentorId], {
      title,
      body: message,
      meetingId: meeting.id,
      kind: 'complete_reminder',
      linkPath: completeMeetingPath(meeting.id),
    });
    sent += 1;
  }
  if (sent > 0) console.log(`📋 Sent ${sent} meeting-completion reminder(s)`);
}

function latestTime(
  rows: Array<{ category?: string | null; created_at?: string | null }>,
  category: string,
) {
  let latest = 0;
  for (const row of rows) {
    if (row.category !== category || !row.created_at) continue;
    const time = new Date(row.created_at).getTime();
    if (Number.isFinite(time) && time > latest) latest = time;
  }
  return latest || null;
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
