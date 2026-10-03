import { googleRequest, GoogleApiError } from './googleAuth.js';

const MEET = 'https://meet.googleapis.com/v2';
const CALENDAR_EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';

export interface MeetSpace {
  name: string;
  meetingUri: string;
  meetingCode: string;
  config?: Record<string, unknown>;
  activeConference?: { conferenceRecord?: string };
}

export interface MeetMember {
  name: string;
  email: string;
  role?: 'COHOST' | 'ROLE_UNSPECIFIED';
}

export interface ConferenceRecord {
  name: string;
  startTime?: string;
  endTime?: string;
  space?: string;
}

export interface DocsDestination {
  document?: string;
  exportUri?: string;
}

export interface MeetArtifact {
  name: string;
  state?: 'STATE_UNSPECIFIED' | 'STARTED' | 'ENDED' | 'FILE_GENERATED';
  startTime?: string;
  endTime?: string;
  docsDestination?: DocsDestination;
}

function autoArtifactsConfig() {
  const record = (process.env.GOOGLE_MEET_AUTO_RECORD || '').toLowerCase() === 'true';
  return {
    recordingConfig: { autoRecordingGeneration: record ? 'ON' : 'OFF' },
    transcriptionConfig: { autoTranscriptionGeneration: 'ON' },
    smartNotesConfig: { autoSmartNotesGeneration: 'ON' },
  };
}

export async function createSpace(): Promise<MeetSpace> {
  return googleRequest<MeetSpace>(`${MEET}/spaces`, {
    method: 'POST',
    data: {
      config: {
        accessType: 'TRUSTED',
        entryPointAccess: 'ALL',
        attendanceReportGenerationType: 'GENERATE_REPORT',
        artifactConfig: autoArtifactsConfig(),
      },
    },
  });
}

export async function getSpace(spaceName: string): Promise<MeetSpace> {
  return googleRequest<MeetSpace>(`${MEET}/${spaceName}`);
}

export async function endActiveConference(spaceName: string): Promise<void> {
  await googleRequest(`${MEET}/${spaceName}:endActiveConference`, { method: 'POST', data: {} });
}

export async function listMembers(spaceName: string): Promise<MeetMember[]> {
  const out: MeetMember[] = [];
  let pageToken: string | undefined;
  do {
    const res = await googleRequest<{ members?: MeetMember[]; nextPageToken?: string }>(
      `${MEET}/${spaceName}/members`,
      { params: { pageSize: 100, pageToken } },
    );
    out.push(...(res.members || []));
    pageToken = res.nextPageToken;
  } while (pageToken);
  return out;
}

/** Adds a member; an already-existing member is treated as success. */
export async function addMember(
  spaceName: string,
  email: string,
  cohost: boolean,
): Promise<MeetMember | null> {
  try {
    return await googleRequest<MeetMember>(`${MEET}/${spaceName}/members`, {
      method: 'POST',
      data: { email, role: cohost ? 'COHOST' : 'ROLE_UNSPECIFIED' },
    });
  } catch (err) {
    if (err instanceof GoogleApiError && err.status === 409) return null;
    throw err;
  }
}

export async function deleteMember(memberName: string): Promise<void> {
  await googleRequest(`${MEET}/${memberName}`, { method: 'DELETE' });
}

export async function listConferenceRecords(spaceName: string): Promise<ConferenceRecord[]> {
  const res = await googleRequest<{ conferenceRecords?: ConferenceRecord[] }>(
    `${MEET}/conferenceRecords`,
    { params: { filter: `space.name="${spaceName}"`, pageSize: 25 } },
  );
  return res.conferenceRecords || [];
}

export async function listTranscripts(recordName: string): Promise<MeetArtifact[]> {
  const res = await googleRequest<{ transcripts?: MeetArtifact[] }>(
    `${MEET}/${recordName}/transcripts`,
  );
  return res.transcripts || [];
}

export async function listSmartNotes(recordName: string): Promise<MeetArtifact[]> {
  const res = await googleRequest<{ smartNotes?: MeetArtifact[] }>(
    `${MEET}/${recordName}/smartNotes`,
  );
  return res.smartNotes || [];
}

export function docUrl(dest?: DocsDestination): string | null {
  return dest?.document ? `https://docs.google.com/document/d/${dest.document}/edit` : null;
}

export async function exportDocText(documentId: string): Promise<string> {
  return googleRequest<string>(`${DRIVE_FILES}/${documentId}/export`, {
    params: { mimeType: 'text/plain' },
    responseType: 'text',
  });
}

export interface CalendarEventInput {
  title: string;
  description: string;
  startIso: string;
  endIso: string;
  timeZone?: string;
  attendeeEmails: string[];
  meetingUri: string;
}

function calendarBody(input: CalendarEventInput) {
  const tz = input.timeZone && input.timeZone !== 'UTC' ? input.timeZone : undefined;
  return {
    summary: input.title,
    description: input.description,
    location: input.meetingUri,
    start: { dateTime: input.startIso, ...(tz ? { timeZone: tz } : {}) },
    end: { dateTime: input.endIso, ...(tz ? { timeZone: tz } : {}) },
    attendees: input.attendeeEmails.map((email) => ({ email })),
    guestsCanModify: false,
    guestsCanInviteOthers: false,
    source: { title: 'Google Meet', url: input.meetingUri },
  };
}

export async function createCalendarEvent(input: CalendarEventInput): Promise<{ id: string }> {
  return googleRequest<{ id: string }>(CALENDAR_EVENTS, {
    method: 'POST',
    params: { sendUpdates: 'all' },
    data: calendarBody(input),
  });
}

export async function updateCalendarEvent(
  eventId: string,
  input: CalendarEventInput,
): Promise<void> {
  await googleRequest(`${CALENDAR_EVENTS}/${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    params: { sendUpdates: 'all' },
    data: calendarBody(input),
  });
}

export async function deleteCalendarEvent(eventId: string): Promise<void> {
  try {
    await googleRequest(`${CALENDAR_EVENTS}/${encodeURIComponent(eventId)}`, {
      method: 'DELETE',
      params: { sendUpdates: 'all' },
    });
  } catch (err) {
    if (err instanceof GoogleApiError && (err.status === 404 || err.status === 410)) return;
    throw err;
  }
}

/** Cheap authenticated call used by the admin status check. */
export async function pingCalendar(): Promise<{ id: string; summary?: string; timeZone?: string }> {
  return googleRequest('https://www.googleapis.com/calendar/v3/calendars/primary');
}
