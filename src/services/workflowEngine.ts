import { supabaseAdmin } from '../config/supabase.js';

export type WorkflowTrigger =
  | 'FIRST_ACCEPTANCE'
  | 'APPLICATION_SUBMITTED'
  | 'INTERVIEW_RECEIVED';

export interface WorkflowTriggerData {
  schoolName?: string;
  [key: string]: unknown;
}

/** Replace UI bracket placeholders and mustache-style tokens. */
export function applyMessagePlaceholders(
  template: string,
  vars: { studentName?: string; schoolName?: string; mentorName?: string }
): string {
  const studentName = vars.studentName || 'Student';
  const firstName = studentName.split(/\s+/)[0] || studentName;
  const schoolName = vars.schoolName || 'the school';
  const mentorName = vars.mentorName || 'Your Mentor';

  return (template || '')
    .replace(/\[Mentee Name\]/gi, firstName)
    .replace(/\[School\]/gi, schoolName)
    .replace(/\[Mentor Name\]/gi, mentorName)
    .replace(/\{\{\s*student_name\s*\}\}/gi, studentName)
    .replace(/\{\{\s*name\s*\}\}/gi, firstName)
    .replace(/\{\{\s*school_name\s*\}\}/gi, schoolName)
    .replace(/\{\{\s*school\s*\}\}/gi, schoolName)
    .replace(/\{\{\s*mentor_name\s*\}\}/gi, mentorName);
}

/**
 * Schedule pending actions for all active workflows matching a trigger.
 */
export async function scheduleWorkflowTrigger(
  trigger: WorkflowTrigger,
  studentId: string,
  triggerData: WorkflowTriggerData = {}
): Promise<{ matchedWorkflowsCount: number; scheduledCount: number }> {
  const { data: matchingWorkflows, error: wErr } = await supabaseAdmin
    .from('workflows')
    .select('*')
    .eq('trigger', trigger)
    .eq('is_active', true);

  if (wErr) {
    console.error('scheduleWorkflowTrigger: fetch workflows error:', wErr.message);
    throw new Error(wErr.message);
  }

  let scheduledCount = 0;

  if (matchingWorkflows && matchingWorkflows.length > 0) {
    for (const workflow of matchingWorkflows) {
      const stepsList = (workflow.steps || []) as Array<{
        id: string;
        delayHours?: number;
      }>;

      for (const step of stepsList) {
        const delayMs = (step.delayHours || 0) * 60 * 60 * 1000;
        const scheduledFor = new Date(Date.now() + delayMs).toISOString();

        const { error: aErr } = await supabaseAdmin.from('pending_workflow_actions').insert({
          workflow_id: workflow.id,
          step_id: step.id,
          student_id: studentId,
          trigger_data: triggerData,
          scheduled_for: scheduledFor,
          status: 'PENDING',
        });

        if (aErr) {
          console.error('scheduleWorkflowTrigger: insert action error:', aErr.message);
        } else {
          scheduledCount += 1;
        }
      }
    }
  }

  return {
    matchedWorkflowsCount: matchingWorkflows?.length || 0,
    scheduledCount,
  };
}

/**
 * Process all pending workflow actions whose scheduled_for is due.
 */
export async function executeDueWorkflowActions(): Promise<{ executedCount: number }> {
  const now = new Date().toISOString();

  const { data: dueActions, error: fetchErr } = await supabaseAdmin
    .from('pending_workflow_actions')
    .select('*, workflow:workflows(*)')
    .eq('status', 'PENDING')
    .lte('scheduled_for', now);

  if (fetchErr) {
    console.error('executeDueWorkflowActions: fetch error:', fetchErr.message);
    throw new Error(fetchErr.message);
  }

  if (!dueActions || dueActions.length === 0) {
    return { executedCount: 0 };
  }

  let executedCount = 0;

  const { data: adminUser } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('role', 'ADMIN')
    .limit(1)
    .maybeSingle();

  for (const action of dueActions) {
    const workflowTemplate = action.workflow;
    if (!workflowTemplate) {
      continue;
    }

    const stepsList = (workflowTemplate.steps || []) as any[];
    const step = stepsList.find((s: any) => s.id === action.step_id);

    if (!step) {
      await supabaseAdmin
        .from('pending_workflow_actions')
        .update({ status: 'CANCELLED', updated_at: new Date().toISOString() })
        .eq('id', action.id);
      continue;
    }

    if (step.type !== 'SEND_MESSAGE') {
      continue;
    }

    const studentId = action.student_id;

    const { data: studentUser } = await supabaseAdmin
      .from('users')
      .select('name')
      .eq('id', studentId)
      .maybeSingle();

    const studentName = studentUser?.name || 'Student';
    const schoolName =
      (action.trigger_data as WorkflowTriggerData | null)?.schoolName || 'the school';

    const { data: profile } = await supabaseAdmin
      .from('student_profiles')
      .select('mentor_id')
      .eq('id', studentId)
      .maybeSingle();

    const senderId = profile?.mentor_id || adminUser?.id;

    if (!senderId) {
      await supabaseAdmin
        .from('pending_workflow_actions')
        .update({ status: 'CANCELLED', updated_at: new Date().toISOString() })
        .eq('id', action.id);
      continue;
    }

    const { data: senderUser } = await supabaseAdmin
      .from('users')
      .select('name')
      .eq('id', senderId)
      .maybeSingle();

    const senderName = senderUser?.name || 'Advisor';

    const formattedText = applyMessagePlaceholders(step.messageTemplate || '', {
      studentName,
      schoolName,
      mentorName: senderName,
    });

    let conversationId = '';

    const { data: conversationList } = await supabaseAdmin
      .from('conversations')
      .select('*')
      .eq('is_group', false)
      .contains('participant_ids', [studentId]);

    const directConv = conversationList?.find((c) =>
      (c.participant_ids || []).includes(senderId)
    );

    if (directConv) {
      conversationId = directConv.id;
    } else {
      const { data: newConv, error: cErr } = await supabaseAdmin
        .from('conversations')
        .insert({
          participant_ids: [studentId, senderId],
          is_group: false,
        })
        .select()
        .single();

      if (!cErr && newConv) {
        conversationId = newConv.id;
      }
    }

    if (!conversationId) {
      continue;
    }

    const { error: msgErr } = await supabaseAdmin.from('messages').insert({
      conversation_id: conversationId,
      sender_id: senderId,
      text: formattedText,
      read_by: [senderId],
    });

    if (msgErr) {
      console.error('executeDueWorkflowActions: message insert error:', msgErr.message);
      continue;
    }

    await supabaseAdmin.from('notifications').insert({
      user_id: studentId,
      title: '💬 New Message',
      message: `${senderName}: ${formattedText.substring(0, 60)}${
        formattedText.length > 60 ? '...' : ''
      }`,
      type: 'INFO',
      category: 'NEW_MESSAGE',
      related_id: conversationId,
      is_read: false,
      created_by: senderId,
    });

    await supabaseAdmin
      .from('pending_workflow_actions')
      .update({ status: 'COMPLETED', updated_at: new Date().toISOString() })
      .eq('id', action.id);

    executedCount += 1;
  }

  return { executedCount };
}

/** Resolve school display name for trigger payloads. */
export async function getSchoolName(schoolId: string | null | undefined): Promise<string> {
  if (!schoolId) return 'the school';
  const { data } = await supabaseAdmin
    .from('schools')
    .select('name')
    .eq('id', schoolId)
    .maybeSingle();
  return data?.name || 'the school';
}

/**
 * Map an application status transition to workflow trigger(s) and schedule them.
 */
export async function handleApplicationStatusWorkflows(opts: {
  studentId: string;
  schoolId: string;
  previousStatus: string | null;
  newStatus: string;
  /** Which table owns this status row (for first-acceptance counting) */
  source?: 'applications' | 'student_schools';
}): Promise<void> {
  const {
    studentId,
    schoolId,
    previousStatus,
    newStatus,
    source = 'applications',
  } = opts;
  if (!newStatus || previousStatus === newStatus) return;

  const schoolName = await getSchoolName(schoolId);
  const triggerData = { schoolName };

  try {
    if (newStatus === 'Applied' && previousStatus !== 'Applied') {
      await scheduleWorkflowTrigger('APPLICATION_SUBMITTED', studentId, triggerData);
    }

    if (newStatus === 'Interviewed' && previousStatus !== 'Interviewed') {
      await scheduleWorkflowTrigger('INTERVIEW_RECEIVED', studentId, triggerData);
    }

    if (newStatus === 'Accepted' && previousStatus !== 'Accepted') {
      const table = source === 'student_schools' ? 'student_schools' : 'applications';
      const { count } = await supabaseAdmin
        .from(table)
        .select('*', { count: 'exact', head: true })
        .eq('student_id', studentId)
        .eq('status', 'Accepted');

      // After the write, this acceptance is included — first if count is 1
      if ((count ?? 0) <= 1) {
        await scheduleWorkflowTrigger('FIRST_ACCEPTANCE', studentId, triggerData);
      }
    }
  } catch (err) {
    console.error('handleApplicationStatusWorkflows error:', err);
  }
}
