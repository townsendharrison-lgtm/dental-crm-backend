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
  today.setHours(0, 0, 0, 0);

  let sentCount = 0;

  for (const req of requests) {
    const dueDate = new Date(req.due_date);
    dueDate.setHours(0, 0, 0, 0);

    // Calculate days difference: negative = before due, positive = after due
    const diffMs = today.getTime() - dueDate.getTime();
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

    // Check if today matches any scheduled reminder day
    if (!config.reminder_schedule.includes(diffDays)) {
      continue;
    }

    // Check if we already sent a reminder for this day
    const { data: existingLog } = await supabaseAdmin
      .from('lor_email_log')
      .select('id')
      .eq('lor_request_id', req.id)
      .eq('email_type', 'REMINDER')
      .eq('days_relative', diffDays)
      .limit(1);

    if (existingLog && existingLog.length > 0) {
      continue; // Already sent for this day
    }

    // Send reminder
    const sent = await sendReminderEmail(req, config, diffDays);

    if (sent) {
      // Log the email
      await supabaseAdmin.from('lor_email_log').insert({
        lor_request_id: req.id,
        email_type: 'REMINDER',
        recipient_email: req.writer_email,
        days_relative: diffDays,
      });

      // Update last_reminder_sent_at
      await supabaseAdmin
        .from('lor_requests')
        .update({ last_reminder_sent_at: new Date().toISOString() })
        .eq('id', req.id);

      sentCount++;
    }
  }

  if (sentCount > 0) {
    console.log(`📧 Sent ${sentCount} LOR reminder email(s)`);
  } else {
    console.log('✅ No LOR reminders needed today');
  }
}
