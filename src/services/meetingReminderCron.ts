import cron from 'node-cron';
import { supabaseAdmin } from '../config/supabase.js';
import { notifyMeetingStartingSoon, type MeetingRow } from './meetingNotifications.js';

const WINDOW_MS = 15 * 60 * 1000;

/**
 * Every minute: notify all parties for meetings starting within the next 15 minutes.
 * Claim via reminder_15_sent_at so each meeting only reminds once (until rescheduled).
 */
export function startMeetingReminderCron() {
  cron.schedule('* * * * *', async () => {
    try {
      await checkAndSendMeetingReminders();
    } catch (err) {
      console.error('❌ Meeting reminder cron error:', err);
    }
  });
  console.log('📅 Meeting 15-min reminder cron scheduled (runs every minute)');
}

export async function checkAndSendMeetingReminders() {
  const now = Date.now();
  const windowStart = new Date(now).toISOString();
  const windowEnd = new Date(now + WINDOW_MS).toISOString();

  const { data: meetings, error } = await supabaseAdmin
    .from('meetings')
    .select('*')
    .eq('completed', false)
    .is('reminder_15_sent_at', null)
    .gt('date', windowStart)
    .lte('date', windowEnd);

  if (error) {
    console.error('Meeting reminder fetch error:', error.message);
    return;
  }

  if (!meetings || meetings.length === 0) return;

  let sent = 0;
  for (const meeting of meetings as MeetingRow[]) {
    // Claim the reminder first to avoid double-send across overlapping ticks
    const { data: claimed, error: claimErr } = await supabaseAdmin
      .from('meetings')
      .update({ reminder_15_sent_at: new Date().toISOString() })
      .eq('id', meeting.id)
      .is('reminder_15_sent_at', null)
      .eq('completed', false)
      .select('id')
      .maybeSingle();

    if (claimErr || !claimed) continue;

    await notifyMeetingStartingSoon({ meeting });
    sent += 1;
  }

  if (sent > 0) {
    console.log(`📅 Sent ${sent} meeting 15-min reminder(s)`);
  }
}
