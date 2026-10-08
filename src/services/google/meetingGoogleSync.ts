import { supabaseAdmin } from '../../config/supabase.js';
import { dsgUserEmail, googleMeetEnabled } from './googleAuth.js';
import {
  addMember,
  createCalendarEvent,
  createSpace,
  deleteCalendarEvent,
  deleteMember,
  docUrl,
  enableCohostArtifacts,
  endActiveConference,
  exportDocText,
  listConferenceRecords,
  listDriveDocs,
  listMembers,
  listSmartNotes,
  listTranscripts,
  type DriveDocFile,
  updateCalendarEvent,
  type MeetArtifact,
} from './meetClient.js';
import { parseMeetingNotes } from './meetingNotesAi.js';
import { sendMeetingGuestEmail, type MeetingInviteKind } from './meetingInviteEmail.js';

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
  notes?: string | null;
  google_space_name?: string | null;
  google_meeting_code?: string | null;
  google_calendar_event_id?: string | null;
  meet_status?: string | null;
  meet_error?: string | null;
  notes_doc_url?: string | null;
  transcript_doc_url?: string | null;
  artifacts_synced_at?: string | null;
}

interface Participant {
  email: string;
  name: string;
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
  const { data: users } = await supabaseAdmin.from('users').select('id, email, name').in('id', ids);
  const byId = new Map(
    (users || []).map((u: any) => [
      u.id,
      { email: (u.email || '').trim().toLowerCase(), name: String(u.name || '').trim() },
    ]),
  );
  const owner = dsgUserEmail().toLowerCase();

  const out = new Map<string, Participant>();
  const push = (id: string | null | undefined, cohost: boolean) => {
    const user = id ? byId.get(id) : null;
    if (!user?.email || user.email === owner) return;
    const prev = out.get(user.email);
    out.set(user.email, {
      email: user.email,
      name: user.name || prev?.name || '',
      cohost: cohost || !!prev?.cohost,
    });
  };
  push(meeting.mentor_id, true);
  for (const a of meeting.attendees || []) push(a, true);
  push(meeting.student_id, false);
  return Array.from(out.values());
}

async function emailGuests(
  kind: MeetingInviteKind,
  meeting: MeetingRecord,
  meetingUri: string,
  participants: Participant[],
): Promise<void> {
  const start = new Date(meeting.date);
  if (Number.isNaN(start.getTime())) return;
  const end = new Date(start.getTime() + (meeting.duration || 30) * 60_000);
  try {
    await sendMeetingGuestEmail({
      kind,
      meetingId: meeting.id,
      title: meeting.title || 'Meeting',
      start,
      end,
      timeZone: meeting.timezone,
      meetingUri,
      guests: participants.map((p) => ({ email: p.email, name: p.name || undefined })),
    });
  } catch (err) {
    console.error(`Meeting guest email failed for ${meeting.id}:`, err);
  }
}

function calendarInput(meeting: MeetingRecord, meetingUri: string, participants: Participant[]) {
  const start = new Date(meeting.date);
  const end = new Date(start.getTime() + (meeting.duration || 30) * 60_000);
  const tz = meeting.timezone && meeting.timezone.includes('/') ? meeting.timezone : undefined;
  return {
    title: meeting.title,
    description:
      `Join Google Meet: ${meetingUri}\n\n` +
      'Join with the Google account this invitation was sent to. ' +
      'Transcription and Gemini notes start when the mentor joins. An admin does not need to be in the call.',
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

    const memberErrors: string[] = [];
    try {
      await enableCohostArtifacts(spaceName);
    } catch (err) {
      memberErrors.push(`Notes setup: ${errText(err)}`);
    }
    const participants = await loadParticipants(meeting);
    memberErrors.push(...(await addMembers(spaceName, participants)));

    let eventId = meeting.google_calendar_event_id || null;
    const input = calendarInput(meeting, meetingUri, participants);
    const inviteKind: MeetingInviteKind = eventId ? 'update' : 'invite';
    if (eventId) {
      await updateCalendarEvent(eventId, input);
    } else {
      eventId = (await createCalendarEvent(input)).id;
    }
    await emailGuests(inviteKind, meeting, meetingUri, participants);

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
    await enableCohostArtifacts(after.google_space_name).catch((e) => memberErrors.push(errText(e)));
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
    await emailGuests('update', after, meetingUri, participants);
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
    const meetingUri = meeting.link?.trim() || '';
    if (meetingUri) {
      const participants = await loadParticipants(meeting);
      await emailGuests('cancel', meeting, meetingUri, participants);
    }
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

const NOTES_MARK = '--- Google Meet notes ---';
const MAX_NOTES_CHARS = 30_000;
const TITLE_STOP = new Set(['meeting', 'session', 'call', 'with', 'from', 'this', 'that', 'your']);

function driveQuote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function titleWords(title: string): string[] {
  const words = title
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4 && !TITLE_STOP.has(w.toLowerCase()));
  return Array.from(new Set(words)).slice(0, 4);
}

function docKind(name: string): 'notes' | 'transcript' | 'other' {
  const n = name.toLowerCase();
  if (n.includes('transcript')) return 'transcript';
  if (n.includes('note') || n.includes('gemini')) return 'notes';
  return 'other';
}

/** Gemini notes and transcripts Google saved in Drive, matched to this meeting. */
async function findDriveDocs(
  meeting: MeetingRecord,
  windowStart: number,
  windowEnd: number,
): Promise<{ notes: DriveDocFile | null; transcript: DriveDocFile | null }> {
  const after = new Date(windowStart - 2 * 60 * 60 * 1000).toISOString();
  const before = new Date(windowEnd + 48 * 60 * 60 * 1000).toISOString();
  const time = `modifiedTime > '${after}' and modifiedTime < '${before}'`;
  const base = `mimeType = 'application/vnd.google-apps.document' and trashed = false and ${time}`;
  const code = (meeting.google_meeting_code || '').trim();
  const words = titleWords(meeting.title || '');

  const queries: string[] = [];
  if (code) queries.push(`${base} and fullText contains '${driveQuote(code)}'`);
  if (words.length) {
    const nameFilter = words.map((w) => `name contains '${driveQuote(w)}'`).join(' and ');
    queries.push(`${base} and ${nameFilter}`);
  }
  if (!queries.length) return { notes: null, transcript: null };

  const byId = new Map<string, DriveDocFile>();
  for (const q of queries) {
    const files = await listDriveDocs(q);
    for (const file of files) byId.set(file.id, file);
  }

  const title = (meeting.title || '').toLowerCase();
  const ranked = Array.from(byId.values())
    .map((file) => {
      const name = file.name.toLowerCase();
      let score = 0;
      if (code && name.includes(code.toLowerCase())) score += 10;
      if (words.length && words.every((w) => name.includes(w.toLowerCase()))) score += 8;
      else if (title.length >= 8 && name.includes(title)) score += 8;
      const kind = docKind(file.name);
      if (kind !== 'other') score += 2;
      return { file, score, kind };
    })
    .filter((row) => row.score >= 8 && row.kind !== 'other')
    .sort((a, b) => b.score - a.score || (b.file.modifiedTime || '').localeCompare(a.file.modifiedTime || ''));

  return {
    notes: ranked.find((row) => row.kind === 'notes')?.file || null,
    transcript: ranked.find((row) => row.kind === 'transcript')?.file || null,
  };
}

function mergeMeetingNotes(existing: string | null | undefined, text: string, docLink: string | null): string {
  const body = text.trim().slice(0, MAX_NOTES_CHARS);
  const block = [NOTES_MARK, docLink ? `Document: ${docLink}` : '', body].filter(Boolean).join('\n');
  const prior = (existing || '').trim();
  if (!prior || prior.includes(NOTES_MARK)) return prior.includes(NOTES_MARK) ? prior : block;
  return `${prior}\n\n${block}`;
}

export type ArtifactSyncResult =
  | 'not_started'
  | 'in_progress'
  | 'waiting_for_files'
  | 'notes_ready'
  | 'no_artifacts'
  | 'skipped';

const DRIVE_RETRY_MS = 14 * 24 * 60 * 60 * 1000;

function docLink(file: DriveDocFile | null): string | null {
  if (!file) return null;
  return file.webViewLink || `https://docs.google.com/document/d/${file.id}/edit`;
}

/**
 * Pull Gemini notes into the meeting's notes field (the manual Meeting notes box).
 * Meet's own file list is checked first. If that is empty, the organizer's Drive is searched.
 */
export async function syncMeetingArtifacts(
  meeting: MeetingRecord,
  { force = false }: { force?: boolean } = {},
): Promise<ArtifactSyncResult> {
  const driveRetry =
    !!meeting.artifacts_synced_at &&
    meeting.meet_status === 'no_artifacts' &&
    !meeting.notes_doc_url &&
    !meeting.transcript_doc_url;
  if (!meeting.google_space_name) return 'skipped';
  if (meeting.artifacts_synced_at && !driveRetry) return 'skipped';

  const now = Date.now();
  const scheduledStart = new Date(meeting.date).getTime();
  const scheduledEnd = scheduledStart + (meeting.duration || 30) * 60_000;

  const records = await listConferenceRecords(meeting.google_space_name);
  if (!records.length) {
    if (!force && now - scheduledEnd > NO_CONFERENCE_GIVE_UP_MS) {
      const saved = await saveDriveNotes(meeting, null, scheduledStart, scheduledEnd);
      if (saved) return 'notes_ready';
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
  const firstStart = Math.min(
    ...records.map((r) => new Date(r.startTime || meeting.date).getTime()),
  );
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
  const fromDrive =
    readyNotes.length || readyTranscripts.length
      ? { notes: null, transcript: null }
      : await findDriveDocs(meeting, firstStart, lastEnd);
  const hasFiles =
    readyNotes.length > 0 ||
    readyTranscripts.length > 0 ||
    !!fromDrive.notes ||
    !!fromDrive.transcript;
  const timedOut = now - lastEnd > ARTIFACT_WAIT_MS;

  if ((pending || !hasFiles) && !timedOut && !force && !driveRetry) {
    await supabaseAdmin
      .from('meetings')
      .update({ meet_status: 'ended', conference_record_name: records[records.length - 1].name })
      .eq('id', meeting.id)
      .is('artifacts_synced_at', null);
    return 'waiting_for_files';
  }

  const notesDoc =
    docUrl(readyNotes[readyNotes.length - 1]?.docsDestination) || docLink(fromDrive.notes);
  const transcriptDoc =
    docUrl(readyTranscripts[readyTranscripts.length - 1]?.docsDestination) ||
    docLink(fromDrive.transcript);
  const patch = {
    meet_status: hasFiles ? 'notes_ready' : 'no_artifacts',
    conference_record_name: records[records.length - 1].name,
    notes_doc_url: notesDoc,
    transcript_doc_url: transcriptDoc,
    artifacts_synced_at: new Date().toISOString(),
  };
  let claim = supabaseAdmin.from('meetings').update(patch).eq('id', meeting.id);
  claim = meeting.artifacts_synced_at ? claim.is('notes_doc_url', null) : claim.is('artifacts_synced_at', null);
  const { data: claimed } = await claim.select('*').maybeSingle();
  if (!claimed || !hasFiles) return hasFiles ? 'skipped' : 'no_artifacts';

  try {
    const source = readyNotes.length || fromDrive.notes ? 'smart_notes' : 'transcript';
    const text = readyNotes.length
      ? await readDocs(readyNotes)
      : fromDrive.notes
        ? await exportDocText(fromDrive.notes.id)
        : readyTranscripts.length
          ? await readDocs(readyTranscripts)
          : fromDrive.transcript
            ? await exportDocText(fromDrive.transcript.id)
            : '';
    if (text.trim()) {
      await supabaseAdmin
        .from('meetings')
        .update({
          notes: mergeMeetingNotes(claimed.notes, text, notesDoc || transcriptDoc),
        })
        .eq('id', meeting.id);
    }

    const parsed = await parseMeetingNotes(text, source);
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

/** Used when Meet has no conference record but Drive may still have the doc. */
async function saveDriveNotes(
  meeting: MeetingRecord,
  conferenceName: string | null,
  windowStart: number,
  windowEnd: number,
): Promise<boolean> {
  const found = await findDriveDocs(meeting, windowStart, windowEnd);
  if (!found.notes && !found.transcript) return false;
  const file = found.notes || found.transcript;
  const link = docLink(file);
  const text = file ? await exportDocText(file.id) : '';
  const { data: claimed } = await supabaseAdmin
    .from('meetings')
    .update({
      meet_status: 'notes_ready',
      conference_record_name: conferenceName,
      notes_doc_url: found.notes ? link : null,
      transcript_doc_url: found.transcript ? docLink(found.transcript) : null,
      notes: mergeMeetingNotes(meeting.notes, text, link),
      artifacts_synced_at: new Date().toISOString(),
    })
    .eq('id', meeting.id)
    .is('artifacts_synced_at', null)
    .select('id')
    .maybeSingle();
  return !!claimed;
}

async function enableCohostNotes(meetings: { id: string; google_space_name?: string | null }[]): Promise<void> {
  for (const m of meetings) {
    if (!m.google_space_name) continue;
    await enableCohostArtifacts(m.google_space_name).catch((err) =>
      console.error(`Meet co-host notes setup failed for meeting ${m.id}:`, err),
    );
  }
}

/** Cron entry: sync every finished Meet meeting from the last few days. */
export async function syncRecentMeetingArtifacts(): Promise<void> {
  if (!googleMeetEnabled()) return;
  const now = Date.now();

  const { data: upcoming } = await supabaseAdmin
    .from('meetings')
    .select('id, google_space_name')
    .not('google_space_name', 'is', null)
    .eq('meet_status', 'provisioned')
    .gte('date', new Date(now).toISOString())
    .limit(50);
  await enableCohostNotes(upcoming || []);

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

  const { data: missed } = await supabaseAdmin
    .from('meetings')
    .select('*')
    .not('google_space_name', 'is', null)
    .eq('meet_status', 'no_artifacts')
    .is('notes_doc_url', null)
    .is('transcript_doc_url', null)
    .gt('date', new Date(now - DRIVE_RETRY_MS).toISOString())
    .limit(50);

  let ready = 0;
  for (const m of [...((meetings || []) as MeetingRecord[]), ...((missed || []) as MeetingRecord[])]) {
    if (m.google_space_name) {
      await enableCohostArtifacts(m.google_space_name).catch((err) =>
        console.error(`Meet co-host notes setup failed for meeting ${m.id}:`, err),
      );
    }
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
