import { supabaseAdmin } from '../config/supabase.js';
import { sendPushToUsers } from './meetingNotifications.js';

export const STUDENT_ONBOARDING_READY_CATEGORY = 'STUDENT_ONBOARDING_READY';

const DEFAULT_STUDENT_STEP_IDS = [
  'student-momentum',
  'student-profile',
  'student-hub',
  'student-inbox',
];

function stepIdsFromGuide(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [...DEFAULT_STUDENT_STEP_IDS];
  const guide = raw as { enabled?: boolean; steps?: unknown };
  if (guide.enabled === false) return [];
  if (!Array.isArray(guide.steps)) return [...DEFAULT_STUDENT_STEP_IDS];
  const ids = guide.steps
    .map((row) => {
      if (!row || typeof row !== 'object') return '';
      const step = row as { id?: unknown; title?: unknown; body?: unknown };
      const title = String(step.title || '').trim();
      const body = String(step.body || '').trim();
      if (!title && !body) return '';
      return String(step.id || '').trim();
    })
    .filter(Boolean);
  return ids.length > 0 ? ids : [...DEFAULT_STUDENT_STEP_IDS];
}

export async function studentOnboardingStepIds(): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from('admin_settings')
    .select('student_onboarding')
    .eq('id', 1)
    .maybeSingle();
  return stepIdsFromGuide(data?.student_onboarding);
}

export function onboardingStepsComplete(requiredIds: string[], completedIds: string[]): boolean {
  if (requiredIds.length === 0) return false;
  const done = new Set(completedIds);
  return requiredIds.every((id) => done.has(id));
}

/** One in-app alert plus a push when a student finishes every onboarding step. */
export async function notifyMentorStudentOnboardingReady(
  studentId: string,
  studentName: string,
): Promise<void> {
  const { data: profile } = await supabaseAdmin
    .from('student_profiles')
    .select('mentor_id')
    .eq('id', studentId)
    .maybeSingle();
  const mentorId = profile?.mentor_id as string | null | undefined;
  if (!mentorId) return;

  const { data: existing } = await supabaseAdmin
    .from('notifications')
    .select('id')
    .eq('user_id', mentorId)
    .eq('category', STUDENT_ONBOARDING_READY_CATEGORY)
    .eq('related_id', studentId)
    .limit(1);
  if (existing && existing.length > 0) return;

  const name = studentName.trim() || 'Your student';
  const title = `${name} finished onboarding`;
  const message = `${name} completed the setup steps. Their information is ready to review.`;

  const { error } = await supabaseAdmin.from('notifications').insert({
    user_id: mentorId,
    title,
    message,
    type: 'INFO',
    category: STUDENT_ONBOARDING_READY_CATEGORY,
    related_id: studentId,
    is_read: false,
    created_by: studentId,
  });
  if (error) {
    console.error('Onboarding ready notification failed:', error.message);
    return;
  }

  await sendPushToUsers([mentorId], {
    title,
    body: message,
    meetingId: studentId,
    kind: STUDENT_ONBOARDING_READY_CATEGORY,
    dataType: STUDENT_ONBOARDING_READY_CATEGORY,
    linkPath: `/mentor/students?studentId=${encodeURIComponent(studentId)}&tab=records`,
  });
}
