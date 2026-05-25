import cron from 'node-cron';
import { supabaseAdmin } from '../config/supabase.js';
import { sendReminderEmail } from './lorEmailService.js';

// ─── LOR Reminder Cron Job ─────────────────────────────────────────
// Runs every hour at :00 to check if any reminders need to be sent.
// Logic:
//   1. Fetch all REQUESTED lor_requests where reminders_stopped = false
//   2. For each, check if today matches any day in reminder_schedule
//   3. If so, and no reminder has been sent for that day, send one
//   4. Skip requests where status != REQUESTED (letters already uploaded)

export function startReminderCron() {
  // Run every hour at minute 0
  cron.schedule('0 * * * *', async () => {
    console.log('⏰ LOR reminder cron running...');
    try {
      await checkAndSendReminders();
    } catch (err) {
      console.error('❌ LOR reminder cron error:', err);
    }
  });
  console.log('📬 LOR reminder cron job scheduled (runs every hour at :00)');
}

export async function checkAndSendReminders() {
  // 1. Get the email config
  const { data: configRow, error: configError } = await supabaseAdmin
    .from('lor_email_config')
    .select('*')
    .limit(1)
    .single();

  if (configError || !configRow) {
    console.log('⚠️ No LOR email config found — skipping reminders');
    return;
  }

  const config = {
    design: configRow.design,
    content: configRow.content,
    reminder_schedule: configRow.reminder_schedule || [],
  };

  if (config.reminder_schedule.length === 0) {
    console.log('⚠️ Empty reminder schedule — skipping');
    return;
  }

  // Normalize schedule entries: support both legacy number[] and new {days,target}[]
  const normalizedSchedule: Array<{ days: number; target: 'writer' | 'requester' }> =
    config.reminder_schedule.map((entry: any) => {
      if (typeof entry === 'number') return { days: entry, target: 'writer' as const };
      return { days: entry.days ?? 0, target: entry.target || 'writer' };
    });

  // 2. Get all active (REQUESTED or DECLINED) requests that haven't stopped reminders
  const { data: requests, error: reqError } = await supabaseAdmin
    .from('lor_requests')
    .select('*')
    .in('status', ['REQUESTED', 'DECLINED'])
    .eq('reminders_stopped', false);

  if (reqError) {
    console.error('❌ Error fetching LOR requests:', reqError.message);
    return;
  }

  if (!requests || requests.length === 0) {
    console.log('✅ No active LOR requests needing reminders');
    return;
  }

  const today = new Date();
  const todayUTC = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());

  let sentCount = 0;

  for (const req of requests) {
    let dueDateUTC: number;
    const dateStr = req.due_date;
    if (dateStr && !dateStr.includes('T') && dateStr.includes('-')) {
      const [year, month, day] = dateStr.split('-').map(Number);
      dueDateUTC = Date.UTC(year, month - 1, day);
    } else {
      const parsedDate = new Date(dateStr || Date.now());
      dueDateUTC = Date.UTC(parsedDate.getFullYear(), parsedDate.getMonth(), parsedDate.getDate());
    }

    // Calculate days difference: negative = before due, positive = after due
    const diffMs = todayUTC - dueDateUTC;
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

    // Check all matching schedule entries for today
    const matchingEntries = normalizedSchedule.filter(e => e.days === diffDays);
    if (matchingEntries.length === 0) continue;

    for (const scheduleEntry of matchingEntries) {
      const targetType = scheduleEntry.target;

      // Check if we already sent a reminder for this day + target
      const { data: existingLog } = await supabaseAdmin
        .from('lor_email_log')
        .select('id')
        .eq('lor_request_id', req.id)
        .eq('email_type', 'REMINDER')
        .eq('days_relative', diffDays)
        .eq('recipient_email', targetType === 'writer' ? req.writer_email : (req.student_email || ''))
        .limit(1);

      if (existingLog && existingLog.length > 0) continue;

      let sent = false;
      let recipientEmail = '';

      if (targetType === 'writer') {
        // Send to letter writer
        sent = await sendReminderEmail(req, config, diffDays, 'writer');
        recipientEmail = req.writer_email;
      } else {
        // Send to student/requester
        if (req.student_email) {
          sent = await sendReminderEmail(req, config, diffDays, 'requester');
          recipientEmail = req.student_email;
        } else {
          console.log(`⚠️ No student email for request ${req.id} — skipping requester reminder`);
          continue;
        }
      }

      if (sent) {
        await supabaseAdmin.from('lor_email_log').insert({
          lor_request_id: req.id,
          email_type: 'REMINDER',
          recipient_email: recipientEmail,
          days_relative: diffDays,
        });

        await supabaseAdmin
          .from('lor_requests')
          .update({ last_reminder_sent_at: new Date().toISOString() })
          .eq('id', req.id);

        sentCount++;
      }
    }
  }

  if (sentCount > 0) {
    console.log(`📧 Sent ${sentCount} LOR reminder email(s)`);
  } else {
    console.log('✅ No LOR reminders needed today');
  }
}
