import cron from 'node-cron';
import { executeDueWorkflowActions } from './workflowEngine.js';

/**
 * Process due workflow queue items every minute.
 */
export function startWorkflowCron() {
  cron.schedule('* * * * *', async () => {
    try {
      const { executedCount } = await executeDueWorkflowActions();
      if (executedCount > 0) {
        console.log(`⚡ Workflow cron executed ${executedCount} action(s)`);
      }
    } catch (err) {
      console.error('❌ Workflow cron error:', err);
    }
  });
  console.log('⚡ Workflow cron job scheduled (runs every minute)');
}
