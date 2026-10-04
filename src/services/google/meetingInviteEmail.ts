import { Resend } from 'resend';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM_EMAIL =
  process.env.LOR_FROM_EMAIL ||
  process.env.INVITE_FROM_EMAIL ||
  'Dental School Guide <no-reply@dentalschoolguide.com>';

export type MeetingInviteKind = 'invite' | 'update' | 'cancel';

export interface MeetingInviteGuest {
  email: string;
  name?: string;
}

function senderName(): string {
  const match = FROM_EMAIL.match(/^\s*([^<]+?)\s*</);
  return match?.[1]?.trim() || 'Dental School Guide';
}

function senderAddress(): string {
  const match = FROM_EMAIL.match(/<([^>]+)>/);
  return (match?.[1] || 'no-reply@dentalschoolguide.com').trim();
}

function icsEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

function icsStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function buildIcs(input: {
  kind: MeetingInviteKind;
  meetingId: string;
  title: string;
  start: Date;
  end: Date;
  meetingUri: string;
  guests: MeetingInviteGuest[];
}): string {
  const method = input.kind === 'cancel' ? 'CANCEL' : 'REQUEST';
  const sequence = input.kind === 'cancel' ? 2 : input.kind === 'update' ? 1 : 0;
  const attendees = input.guests
    .map((guest) => {
      const cn = guest.name?.trim() ? `;CN=${icsEscape(guest.name.trim())}` : '';
      return `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;RSVP=TRUE${cn}:mailto:${guest.email}`;
    })
    .join('\r\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Dental School Guide//Meetings//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${input.meetingId}@dentalschoolguide.com`,
    `DTSTAMP:${icsStamp(new Date())}`,
    `DTSTART:${icsStamp(input.start)}`,
    `DTEND:${icsStamp(input.end)}`,
    `SUMMARY:${icsEscape(input.title)}`,
    `DESCRIPTION:${icsEscape(`Join Google Meet: ${input.meetingUri}`)}`,
    `LOCATION:${icsEscape(input.meetingUri)}`,
    `ORGANIZER;CN=${icsEscape(senderName())}:mailto:${senderAddress()}`,
    attendees,
    `SEQUENCE:${sequence}`,
    `STATUS:${input.kind === 'cancel' ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  return lines.join('\r\n');
}

function formatWhen(start: Date, end: Date, timeZone?: string | null): string {
  const tz = timeZone && timeZone.includes('/') ? timeZone : 'UTC';
  const day = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: tz,
  }).format(start);
  const clock = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: tz,
    timeZoneName: 'short',
  });
  return `${day}, ${clock.format(start)} – ${clock.format(end)}`;
}

function subjectFor(kind: MeetingInviteKind, title: string): string {
  if (kind === 'cancel') return `Cancelled: ${title}`;
  if (kind === 'update') return `Updated meeting: ${title}`;
  return `Meeting invitation: ${title}`;
}

/**
 * Guest email for a Meet session. Sent from Dental School Guide so Gmail does not
 * label Google's calendar-notification message as an unknown sender.
 */
export async function sendMeetingGuestEmail(input: {
  kind: MeetingInviteKind;
  meetingId: string;
  title: string;
  start: Date;
  end: Date;
  timeZone?: string | null;
  meetingUri: string;
  guests: MeetingInviteGuest[];
}): Promise<void> {
  const guests = input.guests.filter((g) => g.email && g.email.includes('@'));
  if (!guests.length) return;
  if (!resend) {
    console.warn('Resend is not configured — meeting guest email was not sent');
    return;
  }

  const when = formatWhen(input.start, input.end, input.timeZone);
  const heading =
    input.kind === 'cancel'
      ? 'This meeting was cancelled'
      : input.kind === 'update'
        ? 'This meeting was updated'
        : 'You are invited to a meeting';
  const joinBlock =
    input.kind === 'cancel'
      ? ''
      : `<p style="margin:24px 0;"><a href="${input.meetingUri}" style="background:#4f46e5;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;display:inline-block;font-weight:600;">Join Google Meet</a></p>
         <p style="margin:0 0 8px;color:#334155;">Or use this link:<br><a href="${input.meetingUri}">${input.meetingUri}</a></p>`;
  const html = `<!DOCTYPE html>
<html><body style="font-family:Arial,sans-serif;color:#0f172a;line-height:1.5;">
  <p style="margin:0 0 8px;font-size:13px;color:#64748b;">Dental School Guide</p>
  <h1 style="font-size:20px;margin:0 0 12px;">${heading}</h1>
  <p style="margin:0 0 8px;"><strong>${input.title}</strong></p>
  <p style="margin:0 0 8px;">${when}</p>
  ${joinBlock}
  <p style="margin:24px 0 0;color:#64748b;font-size:13px;">A calendar file is attached so you can add this to your calendar.</p>
</body></html>`;

  const ics = buildIcs({ ...input, guests });
  const { error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: guests.map((g) => g.email),
    subject: subjectFor(input.kind, input.title),
    html,
    attachments: [
      {
        filename: input.kind === 'cancel' ? 'cancel.ics' : 'meeting.ics',
        content: Buffer.from(ics, 'utf8').toString('base64'),
      },
    ],
  });
  if (error) {
    console.error('Meeting guest email failed:', error);
  }
}
