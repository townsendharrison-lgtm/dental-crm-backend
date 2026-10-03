import { GoogleGenAI, Type } from '@google/genai';

export interface ParsedMeetingNotes {
  summary: string;
  actionItems: Array<{ task: string; dueInDays: number; priority: 'HIGH' | 'MEDIUM' | 'LOW' }>;
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

/**
 * Turn Gemini meeting notes (preferred) or a raw transcript into a short
 * summary plus student action items. Falls back to a trimmed raw excerpt
 * when no Gemini key is configured.
 */
export async function parseMeetingNotes(
  text: string,
  source: 'smart_notes' | 'transcript',
): Promise<ParsedMeetingNotes> {
  const body = text.trim().slice(0, MAX_INPUT_CHARS);
  if (!body) return { summary: '', actionItems: [] };

  const ai = getClient();
  if (!ai) {
    return { summary: body.slice(0, 4000), actionItems: [] };
  }

  const instructions =
    source === 'smart_notes'
      ? 'These are Google Meet "Take notes with Gemini" notes from a dental-school admissions mentoring session.'
      : 'This is a raw Google Meet transcript from a dental-school admissions mentoring session.';

  const response = await ai.models.generateContent({
    model: process.env.MEETING_NOTES_MODEL || 'gemini-2.5-flash',
    contents: [
      {
        role: 'user',
        parts: [
          {
            text:
              `${instructions}\n` +
              'Write a concise summary (max ~200 words) for the CRM, and list the concrete ' +
              'action items the STUDENT agreed to do. Skip action items for the mentor. ' +
              'dueInDays is your best estimate from the conversation (default 7). ' +
              'Do not invent anything not supported by the text.\n\n' +
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
          actionItems: {
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
        },
        required: ['summary', 'actionItems'],
      },
    },
  });

  const parsed = JSON.parse(response.text || '{}');
  const items = Array.isArray(parsed.actionItems) ? parsed.actionItems : [];
  return {
    summary: String(parsed.summary || '').trim(),
    actionItems: items
      .filter((i: any) => typeof i?.task === 'string' && i.task.trim())
      .slice(0, 15)
      .map((i: any) => ({
        task: i.task.trim().slice(0, 500),
        dueInDays: Math.min(90, Math.max(1, Math.round(Number(i.dueInDays) || 7))),
        priority: ['HIGH', 'MEDIUM', 'LOW'].includes(i.priority) ? i.priority : 'MEDIUM',
      })),
  };
}
