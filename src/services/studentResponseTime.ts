import { supabaseAdmin } from '../config/supabase.js';

/**
 * Average hours for a student to reply after the assigned mentor or an admin
 * messages them in a 1:1 DM. Uses the latest staff message before each student reply.
 * Auto-reply template messages are excluded.
 */
export async function recalculateStudentResponseTime(studentId: string): Promise<number> {
  try {
    const { data: profile } = await supabaseAdmin
      .from('student_profiles')
      .select('mentor_id, avg_response_time')
      .eq('id', studentId)
      .maybeSingle();

    if (!profile) return 0;

    const { data: admins } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('role', 'ADMIN');

    const staffIds = new Set<string>();
    if (profile.mentor_id) staffIds.add(profile.mentor_id);
    for (const admin of admins || []) {
      if (admin?.id) staffIds.add(admin.id);
    }

    if (staffIds.size === 0) {
      return await persistAvg(studentId, profile.avg_response_time, 0);
    }

    const { data: settings } = await supabaseAdmin
      .from('admin_settings')
      .select('auto_reply_message')
      .eq('id', 1)
      .maybeSingle();
    const autoReplyText =
      typeof settings?.auto_reply_message === 'string' && settings.auto_reply_message.trim()
        ? settings.auto_reply_message
        : null;

    const { data: conversations } = await supabaseAdmin
      .from('conversations')
      .select('id, participant_ids, is_group')
      .contains('participant_ids', [studentId])
      .eq('is_group', false);

    const relevant = (conversations || []).filter((conv) => {
      const others = (conv.participant_ids || []).filter((id: string) => id !== studentId);
      return others.length === 1 && staffIds.has(others[0]);
    });

    if (relevant.length === 0) {
      return await persistAvg(studentId, profile.avg_response_time, 0);
    }

    const latenciesHours: number[] = [];

    for (const conv of relevant) {
      const { data: messages } = await supabaseAdmin
        .from('messages')
        .select('sender_id, text, created_at')
        .eq('conversation_id', conv.id)
        .order('created_at', { ascending: true });

      let lastStaffAtMs: number | null = null;

      for (const msg of messages || []) {
        const senderId = msg.sender_id as string;
        const isStaff = staffIds.has(senderId);
        const isAutoReply =
          Boolean(autoReplyText) && isStaff && msg.text === autoReplyText;

        if (isAutoReply) continue;

        if (isStaff) {
          lastStaffAtMs = new Date(msg.created_at).getTime();
          continue;
        }

        if (senderId === studentId && lastStaffAtMs != null) {
          const hours =
            (new Date(msg.created_at).getTime() - lastStaffAtMs) / (1000 * 60 * 60);
          if (Number.isFinite(hours) && hours >= 0) {
            latenciesHours.push(hours);
          }
          lastStaffAtMs = null;
        }
      }
    }

    const avg =
      latenciesHours.length === 0
        ? 0
        : Math.round(
            (latenciesHours.reduce((sum, h) => sum + h, 0) / latenciesHours.length) * 10,
          ) / 10;

    return await persistAvg(studentId, profile.avg_response_time, avg);
  } catch (err) {
    console.error('recalculateStudentResponseTime error:', err);
    return 0;
  }
}

async function persistAvg(
  studentId: string,
  previous: unknown,
  avg: number,
): Promise<number> {
  const prevNum = Number(previous);
  if (Number.isFinite(prevNum) && prevNum === avg) return avg;

  await supabaseAdmin
    .from('student_profiles')
    .update({
      avg_response_time: avg,
      updated_at: new Date().toISOString(),
    })
    .eq('id', studentId);

  return avg;
}
