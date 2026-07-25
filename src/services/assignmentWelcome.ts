import { supabaseAdmin } from '../config/supabase.js';

const DEFAULT_ASSIGNMENT_WELCOME = `Hi [Mentee Name],

Your mentor, [Mentor Name], is thrilled to be working with you! They look forward to helping you pursue your dream of becoming a dentist.

To get started, please use the link below to schedule a 30-minute meet-and-greet meeting:

[Meeting Times]

[Timezone]

Feel free to reach out if you have any questions—we are here to support you every step of the way!

Looking forward to your progress!`;

export function fillAssignmentWelcomePlaceholders(
  template: string,
  options: {
    menteeName: string;
    mentorName: string;
    availableTimes?: string[];
    timezone?: string;
  },
): string {
  const menteeFirst = (options.menteeName || 'there').trim().split(/\s+/)[0] || 'there';
  const mentorName = (options.mentorName || 'your mentor').trim() || 'your mentor';
  const times =
    options.availableTimes && options.availableTimes.length > 0
      ? options.availableTimes.map((t) => `• ${t}`).join('\n')
      : '• (times to be confirmed)';
  const timezoneLine = options.timezone?.trim()
    ? `Timezone: ${options.timezone.trim()}`
    : '';

  return template
    .replace(/\[Mentee Name\]/gi, menteeFirst)
    .replace(/\[Mentor Name\]/gi, mentorName)
    .replace(/\[Meeting Times\]/gi, times)
    .replace(/\[Timezone\]/gi, timezoneLine)
    .replace(/\{\{\s*mentee_name\s*\}\}/gi, menteeFirst)
    .replace(/\{\{\s*student_name\s*\}\}/gi, menteeFirst)
    .replace(/\{\{\s*mentor_name\s*\}\}/gi, mentorName)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Find or create a 1:1 DM and send the mentor → student assignment welcome.
 */
export async function sendAssignmentWelcomeDm(options: {
  mentorId: string;
  studentId: string;
  mentorName: string;
  studentName: string;
  welcomeMessage?: string | null;
  availableTimes?: string[];
  timezone?: string;
}): Promise<void> {
  const {
    mentorId,
    studentId,
    mentorName,
    studentName,
    welcomeMessage,
    availableTimes,
    timezone,
  } = options;

  let template = (welcomeMessage || '').trim();
  if (!template) {
    const { data: settings } = await supabaseAdmin
      .from('admin_settings')
      .select('welcome_template_assignment')
      .eq('id', 1)
      .maybeSingle();
    template =
      (typeof settings?.welcome_template_assignment === 'string' &&
        settings.welcome_template_assignment.trim()) ||
      DEFAULT_ASSIGNMENT_WELCOME;
  }

  const text = fillAssignmentWelcomePlaceholders(template, {
    menteeName: studentName,
    mentorName,
    availableTimes,
    timezone,
  });

  if (!text) return;

  // Reuse existing 1:1 conversation when present
  const { data: existing } = await supabaseAdmin
    .from('conversations')
    .select('*')
    .eq('is_group', false)
    .contains('participant_ids', [mentorId, studentId]);

  let conversationId =
    existing?.find((c) => Array.isArray(c.participant_ids) && c.participant_ids.length === 2)
      ?.id || null;

  if (!conversationId) {
    const { data: created, error: cErr } = await supabaseAdmin
      .from('conversations')
      .insert({
        participant_ids: [mentorId, studentId],
        is_group: false,
      })
      .select('id')
      .single();

    if (cErr || !created) {
      throw new Error(cErr?.message || 'Failed to create mentor–student conversation');
    }
    conversationId = created.id;
  }

  const { error: msgErr } = await supabaseAdmin.from('messages').insert({
    conversation_id: conversationId,
    sender_id: mentorId,
    text,
    read_by: [mentorId],
  });

  if (msgErr) {
    throw new Error(msgErr.message || 'Failed to send welcome message');
  }

  await supabaseAdmin.from('notifications').insert({
    user_id: studentId,
    title: `Inbox: ${mentorName || 'Mentor'}`,
    message: text.length > 280 ? `${text.slice(0, 277)}...` : text,
    type: 'INFO',
    category: 'NEW_MESSAGE',
    related_id: conversationId,
    is_read: false,
    created_by: mentorId,
  });
}
