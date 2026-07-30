import { messaging } from '../config/firebase.js';
import { supabaseAdmin } from '../config/supabase.js';

export type AssignmentNotifyKind = 'assign' | 'transfer';

/**
 * Create the in-app ASSIGNMENT notification + FCM push with Accept/Decline CTAs.
 * Used by assign + transfer flows so mentors always get both channels.
 */
export async function notifyMentorOfAssignment(options: {
  mentorId: string;
  assignmentId: string;
  studentName: string;
  createdBy?: string;
  kind?: AssignmentNotifyKind;
}): Promise<{ inAppOk: boolean; pushAttempted: boolean }> {
  const {
    mentorId,
    assignmentId,
    studentName,
    createdBy,
    kind = 'assign',
  } = options;

  const title =
    kind === 'transfer' ? 'New Student Transfer Request' : 'New Student Assignment';
  const message =
    kind === 'transfer'
      ? `${studentName} has been transferred to you. Please accept or decline the assignment.`
      : `You have been assigned a new student: ${studentName}. Please accept or decline the assignment.`;

  const { error: insertError } = await supabaseAdmin.from('notifications').insert({
    user_id: mentorId,
    title,
    message,
    type: 'URGENT',
    category: 'ASSIGNMENT',
    related_id: String(assignmentId),
    is_read: false,
    created_by: createdBy || null,
  });

  if (insertError) {
    console.error('Failed to create assignment in-app notification:', insertError.message);
  }

  await sendAssignmentRequestPush({
    mentorId,
    assignmentId: String(assignmentId),
    studentName,
    kind,
  });

  return { inAppOk: !insertError, pushAttempted: Boolean(messaging) };
}

/**
 * Send a web push for a pending mentor assignment with Accept / Decline CTAs.
 * Uses a data-only FCM payload so the service worker can attach notification actions.
 */
export async function sendAssignmentRequestPush(options: {
  mentorId: string;
  assignmentId: string;
  studentName: string;
  kind?: AssignmentNotifyKind;
}): Promise<void> {
  if (!messaging) {
    console.warn('⚠️ Assignment push skipped — Firebase messaging not initialized');
    return;
  }

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

  const { data: tokens, error: tokenError } = await supabaseAdmin
    .from('fcm_tokens')
    .select('token')
    .eq('user_id', mentorId);

  if (tokenError) {
    console.error('Failed to load FCM tokens for assignment push:', tokenError.message);
    return;
  }

  if (!tokens || tokens.length === 0) {
    console.warn(
      `⚠️ Assignment push skipped — no FCM tokens for mentor ${mentorId}. Mentor must enable push in the app.`,
    );
    return;
  }

  const tokenStrings = tokens.map((t: { token: string }) => t.token);

  try {
    const response = await messaging.sendEachForMulticast({
      tokens: tokenStrings,
      // Data-only: SW shows the notification with Accept/Decline action buttons
      data: {
        type: 'NEW_ASSIGNMENT',
        assignmentId: String(assignmentId),
        studentName: String(studentName),
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

    console.log(
      `🔔 Assignment FCM push: ${response.successCount} ok, ${response.failureCount} failed (mentor ${mentorId})`,
    );

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
