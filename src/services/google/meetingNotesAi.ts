import { GoogleGenAI, Type } from '@google/genai';

export interface ParsedStudentAction {
  task: string;
  dueInDays: number;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface ParsedNextMeeting {
  mentioned: boolean;
  typeName: string;
  date: string;
  time: string;
}

export interface ParsedMeetingNotes {
  summary: string;
  studentActionItems: ParsedStudentAction[];
  mentorActionItems: string[];
  unassignedActionItems: string[];
  nextMeeting: ParsedNextMeeting | null;
}

const MAX_INPUT_CHARS = 120_000;

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI | null {
  if (client) return client;
  const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
  if (!apiKey) return null;
  client = new GoogleGenAI({ apiKey });
  return client;
}

function cleanDate(raw: unknown): string {
  const value = String(raw || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
}

function cleanTime(raw: unknown): string {
  const value = String(raw || '').trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return '';
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return '';
  return `${String(hour).padStart(2, '0')}:${match[2]}`;
}

/**
 * Turn Gemini meeting notes (preferred) or a raw transcript into a draft the
 * mentor reviews on the complete-meeting form. Nothing here is saved as a
 * student task until the mentor submits that form.
 */
export async function parseMeetingNotes(
  text: string,
  source: 'smart_notes' | 'transcript',
  options: { typeLabels?: string[]; meetingDate?: string } = {},
): Promise<ParsedMeetingNotes> {
  const empty: ParsedMeetingNotes = {
    summary: '',
    studentActionItems: [],
    mentorActionItems: [],
    unassignedActionItems: [],
    nextMeeting: null,
  };
  const body = text.trim().slice(0, MAX_INPUT_CHARS);
  if (!body) return empty;

  const ai = getClient();
  if (!ai) {
    return { ...empty, summary: body.slice(0, 4000) };
  }

  const labels = (options.typeLabels || []).map((label) => label.trim()).filter(Boolean);
  const instructions =
    source === 'smart_notes'
      ? 'These are Google Meet "Take notes with Gemini" notes from a dental-school admissions mentoring session.'
      : 'This is a raw Google Meet transcript from a dental-school admissions mentoring session.';
  const meetingDate = options.meetingDate ? options.meetingDate.slice(0, 10) : '';

  const response = await ai.models.generateContent({
    model: process.env.MEETING_NOTES_MODEL || 'gemini-2.5-flash',
    contents: [
      {
        role: 'user',
        parts: [
          {
            text:
              `${instructions}\n` +
              (meetingDate ? `The meeting took place on ${meetingDate}.\n` : '') +
              (labels.length ? `Known session type names: ${labels.join(', ')}.\n` : '') +
              'Write a concise official summary (max ~200 words) a mentor can review and edit. ' +
              'Put a next step in studentActionItems only when the student agreed to do it, or the mentor clearly told the student to do it. ' +
              'Put it in mentorActionItems only when the mentor agreed to do it themselves, such as sending a resource. ' +
              'If the transcript does not make the owner clear, put the step in unassignedActionItems. Do not guess. ' +
              'Do not include document headers such as Full notes, Meeting records, Transcript, or the meeting date stamp. ' +
              'If they agreed on a future meeting, set nextMeeting.mentioned to true. ' +
              'typeName should be the closest known session type, or a short custom name when none fits. ' +
              'date is YYYY-MM-DD only when a calendar date was stated or can be resolved from the meeting date (for example "next Thursday"). ' +
              'time is 24-hour HH:mm only when a clock time was stated. ' +
              'Leave date and time as empty strings when they were not said. Do not invent a time. ' +
              'If no next meeting was discussed, set mentioned to false and leave date and time empty. ' +
              'dueInDays is your best estimate from the conversation (default 7). ' +
              'Do not invent anything the text does not support.\n\n' +
              body,
          },
        ],
      },
    ],
    config: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          summary: { type: Type.STRING },
          studentActionItems: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                task: { type: Type.STRING },
                dueInDays: { type: Type.NUMBER },
                priority: { type: Type.STRING, enum: ['HIGH', 'MEDIUM', 'LOW'] },
              },
              required: ['task'],
            },
          },
          mentorActionItems: { type: Type.ARRAY, items: { type: Type.STRING } },
          unassignedActionItems: { type: Type.ARRAY, items: { type: Type.STRING } },
          nextMeeting: {
            type: Type.OBJECT,
            properties: {
              mentioned: { type: Type.BOOLEAN },
              typeName: { type: Type.STRING },
              date: { type: Type.STRING },
              time: { type: Type.STRING },
            },
            required: ['mentioned'],
          },
        },
        required: ['summary', 'studentActionItems', 'mentorActionItems', 'unassignedActionItems'],
      },
    },
  });

  const parsed = JSON.parse(response.text || '{}');
  const items = Array.isArray(parsed.studentActionItems) ? parsed.studentActionItems : [];
  const mentorItems = Array.isArray(parsed.mentorActionItems) ? parsed.mentorActionItems : [];
  const unassignedItems = Array.isArray(parsed.unassignedActionItems) ? parsed.unassignedActionItems : [];
  const next = parsed.nextMeeting;
  const mentioned = !!next?.mentioned;
  return {
    summary: String(parsed.summary || '').trim(),
    studentActionItems: items
      .filter((item: any) => typeof item?.task === 'string' && item.task.trim())
      .slice(0, 15)
      .map((item: any) => ({
        task: item.task.trim().slice(0, 500),
        dueInDays: Math.min(90, Math.max(1, Math.round(Number(item.dueInDays) || 7))),
        priority: ['HIGH', 'MEDIUM', 'LOW'].includes(item.priority) ? item.priority : 'MEDIUM',
      })),
    mentorActionItems: mentorItems
      .map((item: unknown) => String(item || '').trim())
      .filter(Boolean)
      .slice(0, 15),
    unassignedActionItems: unassignedItems
      .map((item: unknown) => String(item || '').trim())
      .filter(Boolean)
      .slice(0, 15),
    nextMeeting: mentioned
      ? {
          mentioned: true,
          typeName: String(next?.typeName || '').trim().slice(0, 120),
          date: cleanDate(next?.date),
          time: cleanTime(next?.time),
        }
      : null,
  };
}
