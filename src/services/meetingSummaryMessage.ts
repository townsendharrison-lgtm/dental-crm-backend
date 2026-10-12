import { supabaseAdmin } from '../config/supabase.js';

/**
 * Post the completed-meeting summary into the student inbox as the mentor,
 * not as the admin or manager who clicked complete.
 */
export async function sendCompletedMeetingSummary(meeting: {
  mentor_id?: string | null;
  student_id?: string | null;
  summary?: string | null;
}): Promise<void> {
  const text = (meeting.summary || '').trim();
  const studentId = meeting.student_id || null;
  if (!text || !studentId) return;

  const mentorId = await resolveMentorSender(meeting.mentor_id, studentId);
  if (!mentorId || mentorId === studentId) return;

  const conversationId = await findOrCreateDm(mentorId, studentId);
  const { error: msgErr } = await supabaseAdmin.from('messages').insert({
    conversation_id: conversationId,
    sender_id: mentorId,
    text,
    read_by: [mentorId],
  });
  if (msgErr) throw new Error(msgErr.message);

  const { data: mentor } = await supabaseAdmin
    .from('users')
    .select('name')
    .eq('id', mentorId)
    .maybeSingle();

  await supabaseAdmin.from('notifications').insert({
    user_id: studentId,
    title: `Inbox: ${mentor?.name || 'Mentor'}`,
    message: text,
    type: 'INFO',
    category: 'NEW_MESSAGE',
    related_id: conversationId,
    is_read: false,
    created_by: mentorId,
  });
}

async function resolveMentorSender(
  meetingMentorId: string | null | undefined,
  studentId: string,
): Promise<string | null> {
  if (meetingMentorId && (await isMentor(meetingMentorId))) return meetingMentorId;

  const { data: profile } = await supabaseAdmin
    .from('student_profiles')
    .select('mentor_id')
    .eq('id', studentId)
    .maybeSingle();
  if (profile?.mentor_id && (await isMentor(profile.mentor_id))) return profile.mentor_id;
  return null;
}

async function isMentor(userId: string): Promise<boolean> {
  const { data } = await supabaseAdmin.from('users').select('role').eq('id', userId).maybeSingle();
  return data?.role === 'MENTOR';
}

async function findOrCreateDm(mentorId: string, studentId: string): Promise<string> {
  const { data: existing } = await supabaseAdmin
    .from('conversations')
    .select('id, participant_ids')
    .eq('is_group', false)
    .contains('participant_ids', [mentorId, studentId]);

  const match = (existing || []).find(
    (row) =>
      Array.isArray(row.participant_ids) &&
      row.participant_ids.length === 2 &&
      row.participant_ids.includes(mentorId) &&
      row.participant_ids.includes(studentId),
  );
  if (match) return match.id;

  const { data: created, error } = await supabaseAdmin
    .from('conversations')
    .insert({
      name: null,
      participant_ids: [mentorId, studentId],
      is_group: false,
    })
    .select('id')
    .single();
  if (error || !created) throw new Error(error?.message || 'Could not open the mentor conversation');
  return created.id;
}
