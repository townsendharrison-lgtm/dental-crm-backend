import { supabaseAdmin } from '../config/supabase.js';

/**
 * Average hours for a mentor to reply after a student messages them in a 1:1 DM.
 * Uses the latest student message before each mentor reply.
 * Auto-reply template messages are excluded (they do not count as mentor replies).
 */
export async function recalculateMentorResponseTime(mentorId: string): Promise<number> {
  try {
    const { data: profile } = await supabaseAdmin
      .from('mentor_profiles')
      .select('avg_response_time_value, avg_response_time')
      .eq('id', mentorId)
      .maybeSingle();

    if (!profile) return 0;

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
      .contains('participant_ids', [mentorId])
      .eq('is_group', false);

    const relevant = (conversations || []).filter((conv) => {
      const others = (conv.participant_ids || []).filter((id: string) => id !== mentorId);
      return others.length === 1;
    });

    if (relevant.length === 0) {
      return await persistAvg(mentorId, profile.avg_response_time_value, 0);
    }

    const otherIds = [
      ...new Set(
        relevant.flatMap((conv) =>
          (conv.participant_ids || []).filter((id: string) => id !== mentorId),
        ),
      ),
    ];

    const { data: otherUsers } = await supabaseAdmin
      .from('users')
      .select('id, role')
      .in('id', otherIds);

    const studentIds = new Set(
      (otherUsers || []).filter((u) => u.role === 'STUDENT').map((u) => u.id as string),
    );

    const studentConvs = relevant.filter((conv) => {
      const other = (conv.participant_ids || []).find((id: string) => id !== mentorId);
      return other && studentIds.has(other);
    });

    if (studentConvs.length === 0) {
      return await persistAvg(mentorId, profile.avg_response_time_value, 0);
    }

    const latenciesHours: number[] = [];

    for (const conv of studentConvs) {
      const { data: messages } = await supabaseAdmin
        .from('messages')
        .select('sender_id, text, created_at')
        .eq('conversation_id', conv.id)
        .order('created_at', { ascending: true });

      let lastStudentAtMs: number | null = null;

      for (const msg of messages || []) {
        const senderId = msg.sender_id as string;
        const isMentor = senderId === mentorId;
        const isStudent = studentIds.has(senderId);
        const isAutoReply =
          Boolean(autoReplyText) && isMentor && msg.text === autoReplyText;

        if (isAutoReply) continue;

        if (isStudent) {
          lastStudentAtMs = new Date(msg.created_at).getTime();
          continue;
        }

        if (isMentor && lastStudentAtMs != null) {
          const hours =
            (new Date(msg.created_at).getTime() - lastStudentAtMs) / (1000 * 60 * 60);
          if (Number.isFinite(hours) && hours >= 0) {
            latenciesHours.push(hours);
          }
          lastStudentAtMs = null;
        }
      }
    }

    const avg =
      latenciesHours.length === 0
        ? 0
        : Math.round(
            (latenciesHours.reduce((sum, h) => sum + h, 0) / latenciesHours.length) * 10,
          ) / 10;

    return await persistAvg(mentorId, profile.avg_response_time_value, avg);
  } catch (err) {
    console.error('recalculateMentorResponseTime error:', err);
    return 0;
  }
}

function formatAvgLabel(avg: number): string {
  if (!Number.isFinite(avg) || avg <= 0) return '—';
  if (avg < 1) return `${Math.max(1, Math.round(avg * 60))}m`;
  return `${avg}h`;
}

async function persistAvg(
  mentorId: string,
  previous: unknown,
  avg: number,
): Promise<number> {
  const prevNum = Number(previous);
  const label = formatAvgLabel(avg);
  if (Number.isFinite(prevNum) && prevNum === avg) return avg;

  await supabaseAdmin
    .from('mentor_profiles')
    .update({
      avg_response_time: label,
      avg_response_time_value: avg,
      updated_at: new Date().toISOString(),
    })
    .eq('id', mentorId);

  return avg;
}
