import { Resend } from 'resend';

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const FROM_EMAIL = process.env.LOR_FROM_EMAIL || 'Dental School Guide <no-reply@dentalschoolguide.com>';
const UPLOAD_BASE_URL = process.env.LOR_UPLOAD_URL || process.env.FRONTEND_URL || 'http://localhost:3000';

interface LORRequest {
  id: string;
  student_name: string;
  student_email?: string;
  writer_name: string;
  writer_email: string;
  due_date: string;
  access_code: string;
  decline_reason?: string;
}

interface LOREmailConfig {
  design: {
    primaryColor: string;
    logoUrl?: string;
    bannerUrl?: string;
  };
  content: {
    subject: string;
    body: string;
    requirements: string;
    exampleLetter: string;
    requirementsPdfUrl?: string;
    exampleLetterPdfUrl?: string;
  };
  reminder_schedule: number[];
}

function getUploadUrl(accessCode: string): string {
  // Handle hash-based routing: /#/letter-upload?code=XXX
  const base = UPLOAD_BASE_URL.replace(/\/$/, '');
  if (base.includes('#')) {
    return `${base}?code=${accessCode}`;
  }
  return `${base}/#/letter-upload?code=${accessCode}`;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function interpolateVariables(text: string, request: LORRequest): string {
  return text
    .replace(/\{\{student_name\}\}/g, request.student_name)
    .replace(/\{\{writer_name\}\}/g, request.writer_name)
    .replace(/\{\{due_date\}\}/g, formatDate(request.due_date))
    .replace(/\{\{upload_link\}\}/g, getUploadUrl(request.access_code))
    .replace(/\{\{access_code\}\}/g, request.access_code);
}

function buildEmailHtml(options: {
  config: LOREmailConfig;
  title: string;
  bodyHtml: string;
  ctaText: string;
  ctaUrl: string;
  footerNote?: string;
  urgencyColor?: string;
  extraButtons?: Array<{ text: string; url: string }>;
}): string {
  const { config, title, bodyHtml, ctaText, ctaUrl, footerNote, urgencyColor, extraButtons } = options;
  const primaryColor = config.design.primaryColor || '#6366f1';
  const accentColor = urgencyColor || primaryColor;
  const logoUrl = config.design.logoUrl;
  const bannerUrl = config.design.bannerUrl;

  const logoHtml = logoUrl
    ? `<img src="${logoUrl}" alt="Dental School Guide" style="height:40px;max-width:180px;object-fit:contain;margin-bottom:16px;" />`
    : `<div style="font-size:20px;font-weight:800;color:#1e293b;margin-bottom:16px;letter-spacing:-0.5px;">Dental School Guide</div>`;

  const bannerHtml = bannerUrl
    ? `<img src="${bannerUrl}" alt="" style="width:100%;max-height:200px;object-fit:cover;border-radius:12px;margin-bottom:24px;" />`
    : '';

  const extraButtonsHtml = (extraButtons || []).map(btn =>
    `<a href="${btn.url}" target="_blank" style="display:inline-block;padding:12px 28px;background-color:#f1f5f9;color:#334155;font-weight:700;font-size:14px;text-decoration:none;border-radius:10px;margin-right:8px;margin-top:8px;border:1px solid #e2e8f0;">${btn.text}</a>`
  ).join('');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background-color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:40px 20px;">
    <!-- Top accent bar -->
    <div style="height:4px;background:${accentColor};border-radius:4px 4px 0 0;"></div>
    
    <!-- Main card -->
    <div style="background:#ffffff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 16px 16px;padding:40px 32px;box-shadow:0 4px 6px -1px rgba(0,0,0,0.05);">
      ${logoHtml}
      ${bannerHtml}
      
      <h1 style="font-size:22px;font-weight:800;color:#0f172a;margin:0 0 24px 0;line-height:1.3;">${title}</h1>
      
      <div style="font-size:15px;color:#475569;line-height:1.7;margin-bottom:32px;">
        ${bodyHtml}
      </div>

      <!-- Requirements box -->
      ${config.content.requirements ? `
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:20px 24px;margin-bottom:32px;">
        <div style="font-size:11px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px;">Letter Requirements</div>
        <div style="font-size:14px;color:#475569;line-height:1.8;white-space:pre-wrap;">${config.content.requirements}</div>
      </div>` : ''}

      <!-- CTA Button -->
      <div style="text-align:center;margin-bottom:24px;">
        <a href="${ctaUrl}" target="_blank" style="display:inline-block;padding:16px 40px;background-color:${accentColor};color:#ffffff;font-weight:800;font-size:15px;text-decoration:none;border-radius:12px;box-shadow:0 4px 14px ${accentColor}33;">${ctaText}</a>
      </div>

      ${extraButtonsHtml ? `<div style="text-align:center;margin-bottom:24px;">${extraButtonsHtml}</div>` : ''}

      ${footerNote ? `<div style="font-size:12px;color:#94a3b8;text-align:center;margin-top:24px;padding-top:24px;border-top:1px solid #f1f5f9;">${footerNote}</div>` : ''}
    </div>

    <!-- Footer -->
    <div style="text-align:center;padding:24px 0;">
      <p style="font-size:12px;color:#94a3b8;margin:0 0 4px 0;">Sent by <strong style="color:#64748b;">Dental School Guide</strong></p>
      <p style="font-size:11px;color:#cbd5e1;margin:0;">This is an automated message. Please do not reply directly.</p>
    </div>
  </div>
</body>
</html>`;
}

// ─── Send Initial Email ─────────────────────────────────────────────
export async function sendInitialEmail(request: LORRequest, config: LOREmailConfig): Promise<boolean> {
  if (!resend) {
    console.warn('⚠️ Resend not configured — skipping initial email');
    return false;
  }

  const subject = interpolateVariables(config.content.subject, request);
  const bodyText = interpolateVariables(config.content.body, request);
  const bodyHtml = bodyText.replace(/\n/g, '<br/>');
  const uploadUrl = getUploadUrl(request.access_code);

  const extraButtons: Array<{ text: string; url: string }> = [];
  if (config.content.requirementsPdfUrl) {
    extraButtons.push({ text: '📄 View Requirements PDF', url: config.content.requirementsPdfUrl });
  }
  if (config.content.exampleLetterPdfUrl) {
    extraButtons.push({ text: '📝 View Example Letter', url: config.content.exampleLetterPdfUrl });
  }

  const html = buildEmailHtml({
    config,
    title: subject,
    bodyHtml,
    ctaText: '📤 Upload Your Letter',
    ctaUrl: uploadUrl,
    footerNote: `Due Date: <strong>${formatDate(request.due_date)}</strong> · Access Code: <strong>${request.access_code}</strong>`,
    extraButtons,
  });

  try {
    const { error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: request.writer_email,
      subject,
      html,
    });
    if (error) {
      console.error('❌ Resend error (initial):', error);
      return false;
    }
    console.log(`📧 Initial email sent to ${request.writer_email} for ${request.student_name}`);
    return true;
  } catch (err) {
    console.error('❌ Failed to send initial email:', err);
    return false;
  }
}

// ─── Send Reminder Email ────────────────────────────────────────────
export async function sendReminderEmail(
  request: LORRequest,
  config: LOREmailConfig,
  daysRelative: number
): Promise<boolean> {
  if (!resend) {
    console.warn('⚠️ Resend not configured — skipping reminder email');
    return false;
  }

  let title: string;
  let urgencyColor: string;
  let bodyText: string;

  if (daysRelative < 0) {
    // Before due date
    const daysBefore = Math.abs(daysRelative);
    title = `Reminder: Letter for ${request.student_name} due in ${daysBefore} day${daysBefore !== 1 ? 's' : ''}`;
    urgencyColor = '#f59e0b'; // amber
    bodyText = `Dear ${request.writer_name},\n\nThis is a friendly reminder that the letter of recommendation you are writing for ${request.student_name} is due in ${daysBefore} day${daysBefore !== 1 ? 's' : ''} on ${formatDate(request.due_date)}.\n\nPlease upload your letter using the button below at your earliest convenience.`;
  } else if (daysRelative === 0) {
    // Due today
    title = `Today is the due date for ${request.student_name}'s letter`;
    urgencyColor = '#6366f1'; // indigo
    bodyText = `Dear ${request.writer_name},\n\nToday is the due date for the letter of recommendation for ${request.student_name}.\n\nPlease submit your letter using the button below as soon as possible.`;
  } else {
    // Overdue
    title = `Overdue: Letter for ${request.student_name} is ${daysRelative} day${daysRelative !== 1 ? 's' : ''} past due`;
    urgencyColor = '#ef4444'; // red
    bodyText = `Dear ${request.writer_name},\n\nThe letter of recommendation for ${request.student_name} is now ${daysRelative} day${daysRelative !== 1 ? 's' : ''} overdue. The original due date was ${formatDate(request.due_date)}.\n\nPlease submit your letter as soon as possible using the button below. Your timely support is greatly appreciated.`;
  }

  const uploadUrl = getUploadUrl(request.access_code);
  const html = buildEmailHtml({
    config,
    title,
    bodyHtml: bodyText.replace(/\n/g, '<br/>'),
    ctaText: '📤 Upload Your Letter Now',
    ctaUrl: uploadUrl,
    urgencyColor,
    footerNote: `Original Due Date: <strong>${formatDate(request.due_date)}</strong> · Access Code: <strong>${request.access_code}</strong>`,
  });

  try {
    const { error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: request.writer_email,
      subject: title,
      html,
    });
    if (error) {
      console.error('❌ Resend error (reminder):', error);
      return false;
    }
    console.log(`📧 Reminder email sent to ${request.writer_email} (${daysRelative} days relative)`);
    return true;
  } catch (err) {
    console.error('❌ Failed to send reminder email:', err);
    return false;
  }
}

// ─── Send Decline / Re-upload Email ─────────────────────────────────
export async function sendDeclineReuploadEmail(
  request: LORRequest,
  config: LOREmailConfig,
  reason: string
): Promise<boolean> {
  if (!resend) {
    console.warn('⚠️ Resend not configured — skipping decline email');
    return false;
  }

  const title = `Action Needed: Letter for ${request.student_name} requires revision`;
  const uploadUrl = getUploadUrl(request.access_code);

  const bodyText = `Dear ${request.writer_name},\n\nThank you for submitting your letter of recommendation for ${request.student_name}. After review, we've determined that some adjustments are needed before we can accept the letter.\n\n<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:20px 24px;margin:16px 0;">\n<div style="font-size:11px;font-weight:800;color:#dc2626;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:8px;">Reason for Revision</div>\n<div style="font-size:14px;color:#7f1d1d;line-height:1.6;">${reason}</div>\n</div>\n\nPlease make the necessary changes and re-upload the revised letter using the button below.`;

  const html = buildEmailHtml({
    config,
    title,
    bodyHtml: bodyText,
    ctaText: '📤 Upload Revised Letter',
    ctaUrl: uploadUrl,
    urgencyColor: '#ef4444',
    footerNote: `Access Code: <strong>${request.access_code}</strong> · Please re-upload at your earliest convenience.`,
  });

  try {
    const { error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: request.writer_email,
      subject: title,
      html,
    });
    if (error) {
      console.error('❌ Resend error (decline):', error);
      return false;
    }
    console.log(`📧 Decline/re-upload email sent to ${request.writer_email}`);
    return true;
  } catch (err) {
    console.error('❌ Failed to send decline email:', err);
    return false;
  }
}

// ─── Send Test Email ────────────────────────────────────────────────
export async function sendTestEmail(toEmail: string, config: LOREmailConfig): Promise<boolean> {
  if (!resend) {
    console.warn('⚠️ Resend not configured — cannot send test email');
    return false;
  }

  const mockRequest: LORRequest = {
    id: 'test-001',
    student_name: 'Sarah Jenkins',
    writer_name: 'Dr. Miller',
    writer_email: toEmail,
    due_date: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
    access_code: 'LOR-TEST-DM-001',
  };

  return sendInitialEmail(mockRequest, config);
}
