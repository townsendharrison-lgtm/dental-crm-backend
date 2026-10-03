import cron from 'node-cron';
import { googleMeetEnabled } from './google/googleAuth.js';
import { syncRecentMeetingArtifacts } from './google/meetingGoogleSync.js';

let running = false;

/**
 * Every 10 minutes: pull Meet transcripts + Gemini notes for finished meetings.
 * Always scheduled so connecting Google later (Admin settings) needs no restart.
 */
export function startMeetArtifactsCron() {
  cron.schedule('*/10 * * * *', async () => {
    if (running || !googleMeetEnabled()) return;
    running = true;
    try {
      await syncRecentMeetingArtifacts();
    } catch (err) {
      console.error('❌ Meet artifacts cron error:', err);
    } finally {
      running = false;
    }
  });
  console.log(
    `🎙️ Google Meet artifact sync cron scheduled (every 10 minutes, currently ${
      googleMeetEnabled() ? 'active' : 'inactive'
    })`,
  );
}
