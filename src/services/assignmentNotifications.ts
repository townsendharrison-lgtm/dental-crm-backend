import { messaging } from '../config/firebase.js';
import { supabaseAdmin } from '../config/supabase.js';

/**
 * Send a web push for a pending mentor assignment with Accept / Decline CTAs.
 * Uses a data-only FCM payload so the service worker can attach notification actions.
 */
export async function sendAssignmentRequestPush(options: {
  mentorId: string;
  assignmentId: string;
  studentName: string;
  kind?: 'assign' | 'transfer';
}): Promise<void> {
  if (!messaging) return;

  const { mentorId, assignmentId, studentName, kind = 'assign' } = options;
  const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  const baseLink = `${frontendUrl}/mentor/command-center`;
  const link = `${baseLink}?assignmentId=${encodeURIComponent(assignmentId)}`;
  const acceptLink = `${baseLink}?assignmentAction=accept&assignmentId=${encodeURIComponent(assignmentId)}`;
  const declineLink = `${baseLink}?assignmentAction=decline&assignmentId=${encodeURIComponent(assignmentId)}`;

  const title =
    kind === 'transfer' ? 'New Student Transfer Request' : 'New Student Assignment';
  const body =
    kind === 'transfer'
      ? `${studentName} has been transferred to you. Accept or decline now.`
      : `You've been assigned ${studentName}. Accept or decline now.`;

  const { data: tokens } = await supabaseAdmin
    .from('fcm_tokens')
    .select('token')
    .eq('user_id', mentorId);

  if (!tokens || tokens.length === 0) return;

  const tokenStrings = tokens.map((t: { token: string }) => t.token);

  try {
    const response = await messaging.sendEachForMulticast({
      tokens: tokenStrings,
      // Data-only: SW shows the notification with Accept/Decline action buttons
      data: {
        type: 'NEW_ASSIGNMENT',
        assignmentId,
        studentName,
        title,
        body: body.slice(0, 180),
        link,
        acceptLink,
        declineLink,
      },
      webpush: {
        headers: {
          Urgency: 'high',
        },
        fcmOptions: {
          link,
        },
      },
    });

    if (response.failureCount > 0) {
      const invalidTokens: string[] = [];
      response.responses.forEach((r, idx) => {
        if (!r.success && r.error?.code === 'messaging/registration-token-not-registered') {
          invalidTokens.push(tokenStrings[idx]);
        }
      });
      if (invalidTokens.length > 0) {
        await supabaseAdmin.from('fcm_tokens').delete().in('token', invalidTokens);
      }
    }
  } catch (err) {
    console.error('Assignment FCM push error:', err);
  }
}
