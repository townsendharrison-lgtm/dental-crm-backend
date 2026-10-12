import cron from 'node-cron';
import { remindMentorsToCompleteNotedMeetings } from './meetingNotifications.js';

let running = false;

/** Every 15 minutes: re-notify mentors who closed the complete-meeting prompt 24+ hours ago. */
export function startMeetingCompletePromptCron() {
  cron.schedule('*/15 * * * *', async () => {
    if (running) return;
    running = true;
    try {
      await remindMentorsToCompleteNotedMeetings();
    } catch (err) {
      console.error('❌ Meeting completion reminder cron error:', err);
    } finally {
      running = false;
    }
  });
  console.log('📋 Meeting completion reminder cron scheduled (every 15 minutes)');
}
