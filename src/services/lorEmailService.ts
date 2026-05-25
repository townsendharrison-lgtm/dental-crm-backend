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
  if (!dateStr) return '';
  if (!dateStr.includes('T') && dateStr.includes('-')) {
    const parts = dateStr.split('-');
    if (parts.length === 3) {
      const year = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1;
      const day = parseInt(parts[2], 10);
      const d = new Date(Date.UTC(year, month, day));
      return d.toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
      });
    }
  }
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

  // DSG Logo — always use the official one
  const logoUrl = config.design.logoUrl || 'https://images.squarespace-cdn.com/content/64d0277a0640507c114633ad/b8543df7-ec9e-4d64-912e-e80bb44c8757/Untitled+design-3.png?content-type=image%2Fpng';

  const extraButtonsHtml = (extraButtons || []).map(btn =>
    `<a href="${btn.url}" target="_blank" style="display:inline-block;padding:12px 28px;background-color:#1e293b;color:#94a3b8;font-weight:700;font-size:13px;text-decoration:none;border-radius:12px;margin-right:8px;margin-top:8px;border:1px solid #334155;">${btn.text}</a>`
  ).join('');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background-color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:40px 20px;">
    
    <!-- Main card -->
    <div style="background:#0f172a;border:1px solid #1e293b;border-radius:24px;overflow:hidden;">
      
      <!-- Header with gradient -->
      <div style="background:linear-gradient(135deg, ${accentColor} 0%, ${accentColor}cc 50%, ${accentColor}99 100%);padding:40px 36px;text-align:center;">
        <img src="${logoUrl}" alt="Dental School Guide" style="height:36px;max-width:180px;object-fit:contain;margin-bottom:20px;" />
        <h1 style="font-size:24px;font-weight:800;color:#ffffff;margin:0;line-height:1.3;letter-spacing:-0.5px;">${title}</h1>
      </div>
      
      <!-- Body content -->
      <div style="padding:40px 36px;">
        <div style="font-size:15px;color:#94a3b8;line-height:1.8;margin-bottom:32px;">
          ${bodyHtml}
        </div>

        <!-- Requirements box -->
        ${config.content.requirements ? `
        <div style="background:#1e293b;border:1px solid #334155;border-radius:16px;padding:24px 28px;margin-bottom:32px;">
          <div style="font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:2px;margin-bottom:12px;">📋 Letter Requirements</div>
          <div style="font-size:14px;color:#cbd5e1;line-height:1.8;white-space:pre-wrap;">${config.content.requirements}</div>
        </div>` : ''}

        <!-- CTA Button -->
        <div style="text-align:center;margin:36px 0 24px;">
          <a href="${ctaUrl}" target="_blank" style="display:inline-block;padding:16px 48px;background:linear-gradient(135deg, ${accentColor}, ${accentColor}dd);color:#ffffff;font-weight:800;font-size:16px;text-decoration:none;border-radius:16px;box-shadow:0 8px 24px ${accentColor}40;letter-spacing:0.3px;">${ctaText}</a>
        </div>

        <!-- Extra buttons (PDF links etc) -->
        ${extraButtonsHtml ? `<div style="text-align:center;margin-bottom:24px;">${extraButtonsHtml}</div>` : ''}

        <!-- Access code display -->
        ${footerNote ? `
        <div style="background:#1e293b;border:1px solid #334155;border-radius:12px;padding:16px 20px;text-align:center;margin-top:24px;">
          <div style="font-size:12px;color:#64748b;line-height:1.6;">${footerNote}</div>
        </div>` : ''}
      </div>

      <!-- Footer -->
      <div style="padding:24px 36px;border-top:1px solid #1e293b;text-align:center;">
        <p style="font-size:11px;color:#334155;margin:0 0 4px;font-weight:600;text-transform:uppercase;letter-spacing:1px;">Powered by</p>
        <p style="font-size:12px;color:#475569;margin:0 0 8px;font-weight:700;">Dental School Guide</p>
        <p style="font-size:11px;color:#334155;margin:0;">This is an automated message. Please do not reply directly.</p>
      </div>
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
  daysRelative: number,
  target: 'writer' | 'requester' = 'writer'
): Promise<boolean> {
  if (!resend) {
    console.warn('⚠️ Resend not configured — skipping reminder email');
    return false;
  }

  const isRequester = target === 'requester';
  const recipientEmail = isRequester ? request.student_email : request.writer_email;
  if (!recipientEmail) {
    console.warn(`⚠️ No ${target} email for request ${request.id} — skipping`);
    return false;
  }

  let title: string;
  let urgencyColor: string;
  let bodyText: string;

  if (isRequester) {
    // ── Student / Requester reminder ──
    const customBody = (config.content as any).requesterReminderBody;
    if (customBody) {
      bodyText = interpolateVariables(customBody, request);
    } else if (daysRelative < 0) {
      bodyText = `Dear ${request.student_name},\n\nThis is an update regarding your letter of recommendation from ${request.writer_name}. The letter is due on ${formatDate(request.due_date)} and has not yet been uploaded.\n\nWe are continuing to follow up with your letter writer. No action is needed from you at this time.`;
    } else if (daysRelative === 0) {
      bodyText = `Dear ${request.student_name},\n\nToday is the due date for your letter of recommendation from ${request.writer_name}. The letter has not yet been uploaded.\n\nYou may want to reach out to your letter writer directly to check on the status.`;
    } else {
      bodyText = `Dear ${request.student_name},\n\nThe letter of recommendation from ${request.writer_name} is now ${daysRelative} day${daysRelative !== 1 ? 's' : ''} overdue. The original deadline was ${formatDate(request.due_date)}.\n\nWe strongly recommend contacting your letter writer directly to ensure timely submission. If the letter cannot be obtained, please consider arranging an alternative writer.`;
    }

    if (daysRelative < 0) {
      title = `Update: Letter from ${request.writer_name} due in ${Math.abs(daysRelative)} day${Math.abs(daysRelative) !== 1 ? 's' : ''}`;
      urgencyColor = '#f59e0b';
    } else if (daysRelative === 0) {
      title = `Today is the due date for your letter from ${request.writer_name}`;
      urgencyColor = '#6366f1';
    } else {
      title = `Action Needed: Letter from ${request.writer_name} is ${daysRelative} day${daysRelative !== 1 ? 's' : ''} overdue`;
      urgencyColor = '#ef4444';
    }
  } else {
    // ── Writer reminder ──
    const customBody = (config.content as any).writerReminderBody;
    if (customBody) {
      bodyText = interpolateVariables(customBody, request);
    } else if (daysRelative < 0) {
      const daysBefore = Math.abs(daysRelative);
      bodyText = `Dear ${request.writer_name},\n\nThis is a friendly reminder that the letter of recommendation you are writing for ${request.student_name} is due in ${daysBefore} day${daysBefore !== 1 ? 's' : ''} on ${formatDate(request.due_date)}.\n\nPlease upload your letter using the button below at your earliest convenience.`;
    } else if (daysRelative === 0) {
      bodyText = `Dear ${request.writer_name},\n\nToday is the due date for the letter of recommendation for ${request.student_name}.\n\nPlease submit your letter using the button below as soon as possible.`;
    } else {
      bodyText = `Dear ${request.writer_name},\n\nThe letter of recommendation for ${request.student_name} is now ${daysRelative} day${daysRelative !== 1 ? 's' : ''} overdue. The original due date was ${formatDate(request.due_date)}.\n\nPlease submit your letter as soon as possible using the button below. Your timely support is greatly appreciated.`;
    }

    if (daysRelative < 0) {
      const daysBefore = Math.abs(daysRelative);
      title = `Reminder: Letter for ${request.student_name} due in ${daysBefore} day${daysBefore !== 1 ? 's' : ''}`;
      urgencyColor = '#f59e0b';
    } else if (daysRelative === 0) {
      title = `Today is the due date for ${request.student_name}'s letter`;
      urgencyColor = '#6366f1';
    } else {
      title = `Overdue: Letter for ${request.student_name} is ${daysRelative} day${daysRelative !== 1 ? 's' : ''} past due`;
      urgencyColor = '#ef4444';
    }
  }

  const uploadUrl = getUploadUrl(request.access_code);
  const ctaText = isRequester ? '📋 Track Your Request' : '📤 Upload Your Letter Now';
  const ctaUrl = isRequester
    ? (process.env.FRONTEND_URL || 'http://localhost:3000')
    : uploadUrl;

  const html = buildEmailHtml({
    config,
    title,
    bodyHtml: bodyText.replace(/\n/g, '<br/>'),
    ctaText,
    ctaUrl,
    urgencyColor,
    footerNote: `Original Due Date: <strong>${formatDate(request.due_date)}</strong>${!isRequester ? ` · Access Code: <strong>${request.access_code}</strong>` : ''}`,
  });

  try {
    const { error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: recipientEmail,
      subject: title,
      html,
    });
    if (error) {
      console.error(`❌ Resend error (reminder → ${target}):`, error);
      return false;
    }
    console.log(`📧 Reminder email sent to ${recipientEmail} [${target}] (${daysRelative} days relative)`);
    return true;
  } catch (err) {
    console.error(`❌ Failed to send ${target} reminder email:`, err);
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
    access_code: 'LOR-PREVIEW-0000',
  };

  const subject = interpolateVariables(config.content.subject, mockRequest);
  const bodyText = interpolateVariables(config.content.body, mockRequest);

  // Add a test preview banner to the body
  const previewBanner = `<div style="background:#f59e0b;color:#78350f;padding:12px 20px;border-radius:12px;margin-bottom:24px;text-align:center;font-size:13px;font-weight:800;">⚠️ TEST PREVIEW — This is a design preview only. The upload button and access code below are not functional.</div>`;
  const bodyHtml = previewBanner + bodyText.replace(/\n/g, '<br/>');

  const html = buildEmailHtml({
    config,
    title: subject,
    bodyHtml,
    ctaText: '📤 Upload Your Letter (Preview Only)',
    ctaUrl: '#',
    footerNote: `Due Date: <strong>${formatDate(mockRequest.due_date)}</strong> · Access Code: <strong>${mockRequest.access_code}</strong>`,
  });

  try {
    const { error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: toEmail,
      subject: `[TEST] ${subject}`,
      html,
    });
    if (error) {
      console.error('❌ Resend error (test):', error);
      return false;
    }
    console.log(`📧 Test email sent to ${toEmail}`);
    return true;
  } catch (err) {
    console.error('❌ Failed to send test email:', err);
    return false;
  }
}
