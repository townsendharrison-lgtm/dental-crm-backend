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

/** OPEN = anyone with the link joins without knocking; TRUSTED = org + invited members. */
function meetAccessType(): 'OPEN' | 'TRUSTED' | 'RESTRICTED' {
  const v = (process.env.GOOGLE_MEET_ACCESS_TYPE || 'TRUSTED').toUpperCase();
  return v === 'OPEN' || v === 'RESTRICTED' ? v : 'TRUSTED';
}

export async function setSpaceAccessType(
  spaceName: string,
  accessType: 'OPEN' | 'TRUSTED' | 'RESTRICTED',
): Promise<MeetSpace> {
  return googleRequest<MeetSpace>(`${MEET}/${spaceName}`, {
    method: 'PATCH',
    params: { updateMask: 'config.accessType' },
    data: { config: { accessType } },
  });
}

type OptionalFeature = 'attendance' | 'recording' | 'transcription' | 'smartNotes';

function unavailableFeature(err: unknown): OptionalFeature | null {
  if (!(err instanceof GoogleApiError) || err.status !== 403) return null;
  const details = (err.details as any)?.error?.details || [];
  const info = details.find((d: any) => d?.reason === 'FEATURE_UNAVAILABLE_TO_USER');
  const name = String(info?.metadata?.feature_name || err.message).toLowerCase();
  if (!info && !/not available to the user/i.test(err.message)) return null;
  if (name.includes('attendance')) return 'attendance';
  if (name.includes('record')) return 'recording';
  if (name.includes('transcri')) return 'transcription';
  if (name.includes('smartnote') || name.includes('notes') || name.includes('gemini')) return 'smartNotes';
  return null;
}

/** Features the Workspace plan rejected; skipped on later creates. */
const unsupportedFeatures = new Set<OptionalFeature>();

export function unsupportedMeetFeatures(): OptionalFeature[] {
  return Array.from(unsupportedFeatures);
}

function spaceConfig() {
  const artifacts = autoArtifactsConfig() as Record<string, unknown>;
  if (unsupportedFeatures.has('recording')) delete artifacts.recordingConfig;
  if (unsupportedFeatures.has('transcription')) delete artifacts.transcriptionConfig;
  if (unsupportedFeatures.has('smartNotes')) delete artifacts.smartNotesConfig;
  return {
    accessType: meetAccessType(),
    entryPointAccess: 'ALL',
    // Google starts transcripts and Gemini notes only when a host or co-host
    // joins. Co-host is ignored unless host management (moderation) is on, so
    // without this the admin account has to be in the call.
    moderation: 'ON' as const,
    moderationRestrictions: {
      chatRestriction: 'NO_RESTRICTION',
      reactionRestriction: 'NO_RESTRICTION',
      presentRestriction: 'NO_RESTRICTION',
      defaultJoinAsViewerType: 'OFF',
    },
    ...(unsupportedFeatures.has('attendance')
      ? {}
      : { attendanceReportGenerationType: 'GENERATE_REPORT' as const }),
    ...(Object.keys(artifacts).length ? { artifactConfig: artifacts } : {}),
  };
}

/** Creates a space, dropping any optional feature the Workspace plan does not allow. */
export async function createSpace(): Promise<MeetSpace> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await googleRequest<MeetSpace>(`${MEET}/spaces`, {
        method: 'POST',
        data: { config: spaceConfig() },
      });
    } catch (err) {
      const feature = unavailableFeature(err);
      if (!feature || unsupportedFeatures.has(feature)) throw err;
      console.warn(`Google Meet: "${feature}" not available on this Workspace plan; creating without it`);
      unsupportedFeatures.add(feature);
    }
  }
  throw new Error('Could not create Meet space with the available features');
}

export async function getSpace(spaceName: string): Promise<MeetSpace> {
  return googleRequest<MeetSpace>(`${MEET}/${spaceName}`);
}

/** Turn on host management and auto notes so a mentor co-host can start them. */
export async function enableCohostArtifacts(spaceName: string): Promise<void> {
  const config = spaceConfig();
  // Google rejects parent paths like config.artifactConfig. Only leaf fields are valid.
  const mask = [
    'config.moderation',
    'config.moderationRestrictions.chatRestriction',
    'config.moderationRestrictions.reactionRestriction',
    'config.moderationRestrictions.presentRestriction',
    'config.moderationRestrictions.defaultJoinAsViewerType',
  ];
  const artifacts = 'artifactConfig' in config ? config.artifactConfig : undefined;
  if (artifacts && typeof artifacts === 'object') {
    const fields = artifacts as Record<string, unknown>;
    if (fields.recordingConfig) mask.push('config.artifactConfig.recordingConfig.autoRecordingGeneration');
    if (fields.transcriptionConfig) {
      mask.push('config.artifactConfig.transcriptionConfig.autoTranscriptionGeneration');
    }
    if (fields.smartNotesConfig) mask.push('config.artifactConfig.smartNotesConfig.autoSmartNotesGeneration');
  }
  await googleRequest(`${MEET}/${spaceName}`, {
    method: 'PATCH',
    params: { updateMask: mask.join(',') },
    data: { config },
  });
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

export interface DriveDocFile {
  id: string;
  name: string;
  createdTime?: string;
  modifiedTime?: string;
  webViewLink?: string;
}

/** Docs in the connected account's Drive. `q` is a Drive files.list query. */
export async function listDriveDocs(query: string): Promise<DriveDocFile[]> {
  const res = await googleRequest<{ files?: DriveDocFile[] }>(DRIVE_FILES, {
    params: {
      q: query,
      pageSize: 25,
      orderBy: 'modifiedTime desc',
      fields: 'files(id,name,createdTime,modifiedTime,webViewLink)',
      spaces: 'drive',
    },
  });
  return res.files || [];
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
    source: { title: 'Dental School Guide', url: input.meetingUri },
  };
}

/**
 * Google's own invitation mail is labeled "Unknown sender" for people who have
 * never emailed info@dentalschoolguide.com. We keep the event on the DSG calendar
 * and send the guest email ourselves, from Dental School Guide.
 */
const CALENDAR_SEND = { sendUpdates: 'none' as const };

export async function createCalendarEvent(input: CalendarEventInput): Promise<{ id: string }> {
  return googleRequest<{ id: string }>(CALENDAR_EVENTS, {
    method: 'POST',
    params: CALENDAR_SEND,
    data: calendarBody(input),
  });
}

export async function updateCalendarEvent(
  eventId: string,
  input: CalendarEventInput,
): Promise<void> {
  await googleRequest(`${CALENDAR_EVENTS}/${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    params: CALENDAR_SEND,
    data: calendarBody(input),
  });
}

export async function deleteCalendarEvent(eventId: string): Promise<void> {
  try {
    await googleRequest(`${CALENDAR_EVENTS}/${encodeURIComponent(eventId)}`, {
      method: 'DELETE',
      params: CALENDAR_SEND,
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
