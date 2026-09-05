import { Resend } from 'resend';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM_EMAIL = process.env.LOR_FROM_EMAIL || process.env.INVITE_FROM_EMAIL || 'Dental School Guide <no-reply@dentalschoolguide.com>';

const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Administrator',
  MENTOR_MANAGER: 'Mentor Manager',
  MENTOR: 'Mentor',
  STUDENT: 'Student',
  LETTER_WRITER: 'Letter Writer',
  SETTER: 'Setter',
};

interface SendInviteEmailParams {
  email: string;
  role: string;
  inviterName: string;
  actionLink: string;
}

export async function sendInvitationEmail({
  email,
  role,
  inviterName,
  actionLink,
}: SendInviteEmailParams): Promise<{ success: boolean; error?: string }> {
  if (!resend) {
    console.warn('⚠️ Resend is not configured (RESEND_API_KEY missing) — cannot send invite via Resend');
    return { success: false, error: 'Resend API key missing' };
  }

  const roleLabel = ROLE_LABELS[role] || role;
  const subject = `You've been invited to Dental School Guide (${roleLabel})`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.6;
      color: #334155;
      background-color: #0f172a;
      margin: 0;
      padding: 0;
    }
    .wrapper {
      max-width: 600px;
      margin: 32px auto;
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.4);
    }
    .header {
      padding: 36px 32px 28px 32px;
      text-align: center;
      background: linear-gradient(180deg, rgba(99, 102, 241, 0.18) 0%, rgba(30, 41, 59, 0) 100%);
      border-bottom: 1px solid #334155;
    }
    .brand-title {
      font-size: 20px;
      font-weight: 800;
      color: #ffffff;
      margin: 0;
      letter-spacing: -0.02em;
    }
    .content {
      padding: 32px;
      color: #e2e8f0;
    }
    h1 {
      font-size: 22px;
      font-weight: 700;
      color: #ffffff;
      margin-top: 0;
      margin-bottom: 16px;
    }
    p {
      margin: 0 0 16px 0;
      font-size: 15px;
      color: #cbd5e1;
    }
    .badge {
      display: inline-block;
      padding: 4px 12px;
      background-color: rgba(99, 102, 241, 0.2);
      border: 1px solid rgba(99, 102, 241, 0.4);
      color: #a5b4fc;
      border-radius: 9999px;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 20px;
    }
    .btn-container {
      text-align: center;
      margin: 32px 0;
    }
    .btn {
      display: inline-block;
      background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);
      color: #ffffff !important;
      text-decoration: none;
      font-weight: 700;
      font-size: 15px;
      padding: 14px 32px;
      border-radius: 12px;
      box-shadow: 0 4px 14px 0 rgba(79, 70, 229, 0.4);
    }
    .btn:hover {
      background: #4338ca;
    }
    .note {
      font-size: 13px;
      color: #94a3b8;
      background: #0f172a;
      border-radius: 8px;
      padding: 14px;
      margin-top: 24px;
      word-break: break-all;
    }
    .note a {
      color: #818cf8;
      text-decoration: underline;
    }
    .footer {
      padding: 20px 32px;
      text-align: center;
      font-size: 12px;
      color: #64748b;
      border-top: 1px solid #334155;
      background: #0f172a;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" align="center" style="margin: 0 auto 16px auto; border-collapse: collapse;">
        <tr>
          <td align="center" valign="middle" style="width: 64px; height: 64px; background: rgba(255, 255, 255, 0.1); border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 18px; text-align: center; padding: 0;">
            <img src="https://images.squarespace-cdn.com/content/64d0277a0640507c114633ad/b8543df7-ec9e-4d64-912e-e80bb44c8757/Untitled+design-3.png?content-type=image%2Fpng" alt="Dental School Guide" width="48" height="48" style="display: block; margin: 0 auto; width: 48px !important; max-width: 48px !important; height: 48px !important; border: 0; outline: none; text-decoration: none;" />
          </td>
        </tr>
      </table>
      <div class="brand-title">Dental School Guide</div>
    </div>
    <div class="content">
      <h1>Welcome to Dental School Guide</h1>
      <p>Hello,</p>
      <p><strong>${inviterName}</strong> has invited you to join the Dental School Guide platform as a:</p>
      <div class="badge">${roleLabel}</div>
      <p>To get started and activate your account, please click the button below to choose your password and complete your profile setup.</p>
      <div class="btn-container">
        <a href="${actionLink}" class="btn" target="_blank">Accept Invitation & Set Password &rarr;</a>
      </div>
      <div class="note">
        If the button above does not work, copy and paste this link into your browser:<br>
        <a href="${actionLink}">${actionLink}</a>
      </div>
      <p style="font-size: 13px; color: #94a3b8; margin-top: 20px;">
        This invitation link is valid for 7 days. If you did not expect this invitation, you can safely ignore this email.
      </p>
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} Dental School Guide. All rights reserved.
    </div>
  </div>
</body>
</html>
`;

  try {
    const text = `
Welcome to Dental School Guide!

Hello,

${inviterName} has invited you to join the Dental School Guide platform as a ${roleLabel}.

To activate your account and choose your password, please click or open the link below:
${actionLink}

This invitation link is valid for 7 days. If you did not expect this invitation, you can safely ignore this email.

© ${new Date().getFullYear()} Dental School Guide. All rights reserved.
`.trim();

    const { error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: [email],
      subject,
      html,
      text,
    });

    if (error) {
      console.error('❌ Resend invitation error:', error);
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (err: any) {
    console.error('❌ Resend exception while sending invitation:', err);
    return { success: false, error: err?.message || 'Failed to send invite email' };
  }
}
