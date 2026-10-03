import { supabaseAdmin } from '../../config/supabase.js';
import { dsgUserEmail, googleMeetEnabled } from './googleAuth.js';
import {
  addMember,
  createCalendarEvent,
  createSpace,
  deleteCalendarEvent,
  deleteMember,
  docUrl,
  endActiveConference,
  exportDocText,
  listConferenceRecords,
  listMembers,
  listSmartNotes,
  listTranscripts,
  updateCalendarEvent,
  type MeetArtifact,
} from './meetClient.js';
import { parseMeetingNotes } from './meetingNotesAi.js';

const AUTO_MEET_AUDIENCES = new Set(['STUDENT', 'ADMIN_DIRECT', 'STAFF']);
const ARTIFACT_WAIT_MS = 6 * 60 * 60 * 1000;
const NO_CONFERENCE_GIVE_UP_MS = 24 * 60 * 60 * 1000;
const SYNC_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;

export interface MeetingRecord {
  id: string;
  title: string;
  date: string;
  timezone?: string | null;
  duration?: number | null;
  audience?: string | null;
  type?: string | null;
  mentor_id: string;
  student_id?: string | null;
  attendees?: string[] | null;
  link?: string | null;
  summary?: string | null;
  google_space_name?: string | null;
  google_meeting_code?: string | null;
  google_calendar_event_id?: string | null;
  meet_status?: string | null;
  meet_error?: string | null;
  artifacts_synced_at?: string | null;
}

interface Participant {
  email: string;
  cohost: boolean;
}

function isMeetUri(link?: string | null): boolean {
  return !!link && /^https:\/\/meet\.google\.com\//i.test(link.trim());
}

/** New meetings get an automatic Meet link when no custom link was provided. */
export function shouldAutoProvision(meeting: MeetingRecord, autoMeet?: boolean): boolean {
  if (!googleMeetEnabled() || autoMeet === false) return false;
  if (meeting.link && meeting.link.trim()) return false;
  return AUTO_MEET_AUDIENCES.has(meeting.audience || 'STUDENT');
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 1000);
}

async function loadParticipants(meeting: MeetingRecord): Promise<Participant[]> {
  const ids = Array.from(
    new Set([meeting.mentor_id, meeting.student_id, ...(meeting.attendees || [])].filter(Boolean)),
  ) as string[];
  if (!ids.length) return [];
  const { data: users } = await supabaseAdmin.from('users').select('id, email').in('id', ids);
  const emailById = new Map((users || []).map((u: any) => [u.id, (u.email || '').trim().toLowerCase()]));
  const owner = dsgUserEmail().toLowerCase();

  const out = new Map<string, Participant>();
  const push = (id: string | null | undefined, cohost: boolean) => {
    const email = id ? emailById.get(id) : null;
    if (!email || email === owner) return;
    const prev = out.get(email);
    out.set(email, { email, cohost: cohost || !!prev?.cohost });
  };
  push(meeting.mentor_id, true);
  for (const a of meeting.attendees || []) push(a, true);
  push(meeting.student_id, false);
  return Array.from(out.values());
}

function calendarInput(meeting: MeetingRecord, meetingUri: string, participants: Participant[]) {
  const start = new Date(meeting.date);
  const end = new Date(start.getTime() + (meeting.duration || 30) * 60_000);
  const tz = meeting.timezone && meeting.timezone.includes('/') ? meeting.timezone : undefined;
  return {
    title: meeting.title,
    description:
      `Join Google Meet: ${meetingUri}\n\n` +
      'This session is hosted by Dental School Guide. It is automatically transcribed and ' +
      'summarized with Gemini notes for your mentoring record.',
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    timeZone: tz,
    attendeeEmails: participants.map((p) => p.email),
    meetingUri,
  };
}

async function addMembers(spaceName: string, participants: Participant[]): Promise<string[]> {
  const errors: string[] = [];
  for (const p of participants) {
    try {
      await addMember(spaceName, p.email, p.cohost);
    } catch (err) {
      errors.push(`${p.email}${p.cohost ? ' (co-host)' : ''}: ${errText(err)}`);
    }
  }
  return errors;
}

/**
 * Create (or finish creating) the Meet space + DSG calendar invite for a meeting.
 * Never throws: failures are recorded on meet_status/meet_error.
 */
export async function provisionMeetingGoogle(meetingId: string): Promise<void> {
  const { data: claimed } = await supabaseAdmin
    .from('meetings')
    .update({ meet_status: 'pending', meet_error: null })
    .eq('id', meetingId)
    .or('meet_status.is.null,meet_status.eq.failed')
    .select('*')
    .maybeSingle();
  if (!claimed) return;
  const meeting = claimed as MeetingRecord;

  let spaceName = meeting.google_space_name || null;
  let meetingUri = isMeetUri(meeting.link) ? meeting.link!.trim() : null;
  let meetingCode = meeting.google_meeting_code || null;

  try {
    if (!spaceName) {
      const space = await createSpace();
      spaceName = space.name;
      meetingUri = space.meetingUri;
      meetingCode = space.meetingCode;
      await supabaseAdmin
        .from('meetings')
        .update({ google_space_name: spaceName, google_meeting_code: meetingCode, link: meetingUri })
        .eq('id', meetingId);
    }
    if (!meetingUri) throw new Error('Meet space has no meetingUri');

    const participants = await loadParticipants(meeting);
    const memberErrors = await addMembers(spaceName, participants);

    let eventId = meeting.google_calendar_event_id || null;
    const input = calendarInput(meeting, meetingUri, participants);
    if (eventId) {
      await updateCalendarEvent(eventId, input);
    } else {
      eventId = (await createCalendarEvent(input)).id;
    }

    await supabaseAdmin
      .from('meetings')
      .update({
        google_calendar_event_id: eventId,
        link: meetingUri,
        meet_status: 'provisioned',
        meet_error: memberErrors.length ? `Member warnings: ${memberErrors.join(' | ')}` : null,
      })
      .eq('id', meetingId);
  } catch (err) {
    console.error(`Google Meet provision failed for meeting ${meetingId}:`, err);
    await supabaseAdmin
      .from('meetings')
      .update({ meet_status: 'failed', meet_error: errText(err) })
      .eq('id', meetingId);
  }
}

function scheduleChanged(a: MeetingRecord, b: MeetingRecord): boolean {
  return (
    a.title !== b.title ||
    a.date !== b.date ||
    (a.duration || 30) !== (b.duration || 30) ||
    (a.timezone || '') !== (b.timezone || '')
  );
}

function peopleChanged(a: MeetingRecord, b: MeetingRecord): boolean {
  const key = (m: MeetingRecord) =>
    [m.mentor_id, m.student_id || '', ...[...(m.attendees || [])].sort()].join('|');
  return key(a) !== key(b);
}

/** Keep Meet members + calendar invite in sync after a meeting is edited. Never throws. */
export async function syncMeetingGoogleOnUpdate(
  before: MeetingRecord,
  after: MeetingRecord,
): Promise<void> {
  if (!googleMeetEnabled()) return;
  try {
    if (!after.google_space_name) {
      if (!after.link && AUTO_MEET_AUDIENCES.has(after.audience || 'STUDENT')) {
        await provisionMeetingGoogle(after.id);
      }
      return;
    }
    if (after.link && !isMeetUri(after.link)) return;

    const people = peopleChanged(before, after);
    if (!people && !scheduleChanged(before, after)) return;

    const participants = await loadParticipants(after);
    const memberErrors: string[] = [];
    if (people) {
      const wanted = new Map(participants.map((p) => [p.email, p]));
      const existing = await listMembers(after.google_space_name);
      for (const m of existing) {
        const want = wanted.get((m.email || '').toLowerCase());
        if (!want || (want.cohost !== (m.role === 'COHOST'))) {
          await deleteMember(m.name).catch((e) => memberErrors.push(errText(e)));
        }
      }
      memberErrors.push(...(await addMembers(after.google_space_name, participants)));
    }

    const meetingUri = after.link?.trim() || `https://meet.google.com/${after.google_meeting_code}`;
    const input = calendarInput(after, meetingUri, participants);
    if (after.google_calendar_event_id) {
      await updateCalendarEvent(after.google_calendar_event_id, input);
    } else {
      const { id } = await createCalendarEvent(input);
      await supabaseAdmin.from('meetings').update({ google_calendar_event_id: id }).eq('id', after.id);
    }
    await supabaseAdmin
      .from('meetings')
      .update({ meet_error: memberErrors.length ? `Member warnings: ${memberErrors.join(' | ')}` : null })
      .eq('id', after.id);
  } catch (err) {
    console.error(`Google Meet update sync failed for meeting ${after.id}:`, err);
    await supabaseAdmin.from('meetings').update({ meet_error: errText(err) }).eq('id', after.id);
  }
}

/** Cancel the DSG calendar invite (emails attendees) and end any live call. Never throws. */
export async function cancelMeetingGoogle(meeting: MeetingRecord): Promise<void> {
  if (!googleMeetEnabled()) return;
  try {
    if (meeting.google_calendar_event_id) {
      await deleteCalendarEvent(meeting.google_calendar_event_id);
    }
    if (meeting.google_space_name) {
      await endActiveConference(meeting.google_space_name).catch(() => undefined);
    }
  } catch (err) {
    console.error(`Google Meet cancel failed for meeting ${meeting.id}:`, err);
  }
}

function byStart(a: MeetArtifact, b: MeetArtifact) {
  return (a.startTime || '').localeCompare(b.startTime || '');
}

async function readDocs(artifacts: MeetArtifact[]): Promise<string> {
  const parts: string[] = [];
  for (const a of artifacts) {
    if (!a.docsDestination?.document) continue;
    parts.push(await exportDocText(a.docsDestination.document));
  }
  return parts.join('\n\n').trim();
}

export type ArtifactSyncResult =
  | 'not_started'
  | 'in_progress'
  | 'waiting_for_files'
  | 'notes_ready'
  | 'no_artifacts'
  | 'skipped';

/**
 * Pull transcripts + Gemini notes for one meeting, write summary + action items.
 * Idempotent: claims the meeting via artifacts_synced_at before writing action items.
 */
export async function syncMeetingArtifacts(
  meeting: MeetingRecord,
  { force = false }: { force?: boolean } = {},
): Promise<ArtifactSyncResult> {
  if (!meeting.google_space_name || meeting.artifacts_synced_at) return 'skipped';
  const now = Date.now();
  const scheduledEnd = new Date(meeting.date).getTime() + (meeting.duration || 30) * 60_000;

  const records = await listConferenceRecords(meeting.google_space_name);
  if (!records.length) {
    if (!force && now - scheduledEnd > NO_CONFERENCE_GIVE_UP_MS) {
      await supabaseAdmin
        .from('meetings')
        .update({ meet_status: 'no_artifacts', artifacts_synced_at: new Date().toISOString() })
        .eq('id', meeting.id)
        .is('artifacts_synced_at', null);
      return 'no_artifacts';
    }
    return 'not_started';
  }
  if (records.some((r) => !r.endTime)) return 'in_progress';

  const lastEnd = Math.max(...records.map((r) => new Date(r.endTime!).getTime()));
  const transcripts: MeetArtifact[] = [];
  const notes: MeetArtifact[] = [];
  for (const r of records) {
    transcripts.push(...(await listTranscripts(r.name)));
    notes.push(...(await listSmartNotes(r.name)));
  }
  transcripts.sort(byStart);
  notes.sort(byStart);

  const pending = [...transcripts, ...notes].some((a) => a.state !== 'FILE_GENERATED');
  const readyNotes = notes.filter((a) => a.state === 'FILE_GENERATED');
  const readyTranscripts = transcripts.filter((a) => a.state === 'FILE_GENERATED');
  const timedOut = now - lastEnd > ARTIFACT_WAIT_MS;

  if ((pending || (!readyNotes.length && !readyTranscripts.length)) && !timedOut && !force) {
    await supabaseAdmin
      .from('meetings')
      .update({ meet_status: 'ended', conference_record_name: records[records.length - 1].name })
      .eq('id', meeting.id)
      .is('artifacts_synced_at', null);
    return 'waiting_for_files';
  }

  const hasFiles = readyNotes.length > 0 || readyTranscripts.length > 0;
  const { data: claimed } = await supabaseAdmin
    .from('meetings')
    .update({
      meet_status: hasFiles ? 'notes_ready' : 'no_artifacts',
      conference_record_name: records[records.length - 1].name,
      notes_doc_url: docUrl(readyNotes[readyNotes.length - 1]?.docsDestination),
      transcript_doc_url: docUrl(readyTranscripts[readyTranscripts.length - 1]?.docsDestination),
      artifacts_synced_at: new Date().toISOString(),
    })
    .eq('id', meeting.id)
    .is('artifacts_synced_at', null)
    .select('*')
    .maybeSingle();
  if (!claimed || !hasFiles) return hasFiles ? 'skipped' : 'no_artifacts';

  try {
    const source = readyNotes.length ? 'smart_notes' : 'transcript';
    const text = await readDocs(readyNotes.length ? readyNotes : readyTranscripts);
    const parsed = await parseMeetingNotes(text, source);

    if (parsed.summary) {
      const prior = (claimed.summary || '').trim();
      const summary = prior
        ? `${prior}\n\n--- Gemini meeting notes ---\n${parsed.summary}`
        : parsed.summary;
      await supabaseAdmin.from('meetings').update({ summary }).eq('id', meeting.id);
    }

    if (claimed.student_id && parsed.actionItems.length) {
      const rows = parsed.actionItems.map((item) => ({
        student_id: claimed.student_id,
        meeting_id: meeting.id,
        task: item.task,
        due_date: new Date(lastEnd + item.dueInDays * 24 * 60 * 60 * 1000).toISOString(),
        priority: item.priority,
        status: 'PENDING',
        category: 'Meeting',
        description: `From Gemini notes: ${claimed.title}`,
      }));
      const { error } = await supabaseAdmin.from('action_items').insert(rows);
      if (error) throw new Error(`action_items insert: ${error.message}`);
    }
  } catch (err) {
    console.error(`Meeting notes parse failed for meeting ${meeting.id}:`, err);
    await supabaseAdmin.from('meetings').update({ meet_error: errText(err) }).eq('id', meeting.id);
  }
  return 'notes_ready';
}

/** Cron entry: sync every finished Meet meeting from the last few days. */
export async function syncRecentMeetingArtifacts(): Promise<void> {
  if (!googleMeetEnabled()) return;
  const now = Date.now();
  const { data: meetings, error } = await supabaseAdmin
    .from('meetings')
    .select('*')
    .not('google_space_name', 'is', null)
    .is('artifacts_synced_at', null)
    .in('meet_status', ['provisioned', 'ended'])
    .lt('date', new Date(now).toISOString())
    .gt('date', new Date(now - SYNC_LOOKBACK_MS).toISOString())
    .limit(50);
  if (error) {
    console.error('Meet artifact sync fetch error:', error.message);
    return;
  }

  let ready = 0;
  for (const m of (meetings || []) as MeetingRecord[]) {
    const end = new Date(m.date).getTime() + (m.duration || 30) * 60_000;
    if (end > now) continue;
    try {
      if ((await syncMeetingArtifacts(m)) === 'notes_ready') ready += 1;
    } catch (err) {
      console.error(`Meet artifact sync failed for meeting ${m.id}:`, err);
    }
  }
  if (ready > 0) console.log(`🎙️ Synced Gemini notes for ${ready} meeting(s)`);
}
