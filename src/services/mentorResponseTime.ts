import { supabaseAdmin } from '../config/supabase.js';

const CLOSER_EXACT = new Set([
  'ok',
  'okay',
  'k',
  'kk',
  'thanks',
  'thank you',
  'thankyou',
  'ty',
  'thx',
  'got it',
  'gotcha',
  'sounds good',
  'sounds great',
  'perfect',
  'great',
  'awesome',
  'cool',
  'nice',
  'noted',
  'understood',
  'will do',
  'on it',
  'appreciate it',
  'appreciated',
  'no problem',
  'no worries',
  'np',
  'you too',
  'yes',
  'yep',
  'yeah',
  'yup',
  'no',
  'nope',
  'good',
  'makes sense',
  'that works',
  'works for me',
  'see you',
  'see you then',
  'talk soon',
  'talk then',
  'bye',
  'goodbye',
  'have a good one',
  'thanks so much',
  'thank you so much',
  'ok thanks',
  'okay thanks',
  'ok thank you',
  'thanks again',
  'great thanks',
  'perfect thanks',
  'sounds good thanks',
  'got it thanks',
  'will do thanks',
]);

const REQUEST_PATTERN =
  /\b(can you|could you|would you|will you|please|let me know|lmk|i need|help me|when can|how do i|how should|what should|wondering|take a look|review this|thoughts on|question)\b/i;

function normalizeChatText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[!.,]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A student message starts the mentor's reply clock only when it asks for a response.
 * Short closers ("thanks", "sounds good") after the mentor already answered do not.
 */
export function studentMessageNeedsReply(text: string | null | undefined): boolean {
  const raw = String(text || '').trim();
  if (!raw) return false;
  const normalized = normalizeChatText(raw);
  if (!normalized || CLOSER_EXACT.has(normalized)) return false;
  if (
    !raw.includes('?') &&
    /^(thanks|thank you|ok|okay|got it|sounds good|perfect|great|awesome|cool|noted|will do)\b/.test(
      normalized,
    ) &&
    normalized.length < 80
  ) {
    return false;
  }
  if (raw.includes('?')) return true;
  return REQUEST_PATTERN.test(raw);
}

/**
 * Average hours for this mentor to reply after one of their students asks for a response
 * in a 1:1 DM. Chats with admins, mentor managers, and other staff are ignored.
 * Auto-replies are ignored. A student closer ("thanks") does not start a new wait,
 * and an unanswered closer at the end of the thread is not counted.
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
      (otherUsers || [])
        .filter((u) => String(u.role || '').trim().toUpperCase() === 'STUDENT')
        .map((u) => u.id as string),
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

      let pendingQuestionAtMs: number | null = null;

      for (const msg of messages || []) {
        const senderId = msg.sender_id as string;
        const isMentor = senderId === mentorId;
        const isStudent = studentIds.has(senderId);
        const isAutoReply =
          Boolean(autoReplyText) && isMentor && msg.text === autoReplyText;

        if (isAutoReply || (!isMentor && !isStudent)) continue;

        if (isStudent) {
          if (studentMessageNeedsReply(msg.text) && pendingQuestionAtMs == null) {
            pendingQuestionAtMs = new Date(msg.created_at).getTime();
          }
          continue;
        }

        if (isMentor && pendingQuestionAtMs != null) {
          const hours =
            (new Date(msg.created_at).getTime() - pendingQuestionAtMs) / (1000 * 60 * 60);
          if (Number.isFinite(hours) && hours >= 0) {
            latenciesHours.push(hours);
          }
          pendingQuestionAtMs = null;
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
