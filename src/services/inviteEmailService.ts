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
  const isGenericAdmin = !inviterName || /^(admin|admin user|administrator)$/i.test(inviterName.trim());
  const inviterText = isGenericAdmin ? '' : ` by ${inviterName.trim()}`;
  const subject = `You're invited to Dental School Guide`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark only">
  <meta name="supported-color-schemes" content="dark only">
  <title>${subject}</title>
  <style>
    :root {
      color-scheme: dark only;
      supported-color-schemes: dark only;
    }
    html, body {
      margin: 0 !important;
      padding: 0 !important;
      width: 100% !important;
      background-color: #090d16 !important;
      background: #090d16 !important;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      -webkit-text-size-adjust: 100%;
      -ms-text-size-adjust: 100%;
    }
    table, td, a {
      -webkit-text-size-adjust: 100%;
      -ms-text-size-adjust: 100%;
    }
    img {
      -ms-interpolation-mode: bicubic;
      border: 0;
      outline: none;
      text-decoration: none;
    }
    [data-ogsc] body, [data-ogsb] body,
    [data-ogsc] .body-bg, [data-ogsb] .body-bg {
      background-color: #090d16 !important;
      background: #090d16 !important;
    }
  </style>
</head>
<body bgcolor="#090d16" style="margin: 0; padding: 0; width: 100% !important; background-color: #090d16 !important; background: #090d16 !important; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">

  <!-- Outer Full-Width Dark Background Table -->
  <table role="presentation" width="100%" bgcolor="#090d16" class="body-bg" border="0" cellpadding="0" cellspacing="0" style="width: 100% !important; background-color: #090d16 !important; background: #090d16 !important; margin: 0; padding: 36px 12px; border-collapse: collapse;">
    <tr>
      <td align="center" bgcolor="#090d16" class="body-bg" style="background-color: #090d16 !important; background: #090d16 !important;">
        
        <!-- Main Card Container -->
        <table role="presentation" width="100%" bgcolor="#0f172a" border="0" cellpadding="0" cellspacing="0" style="max-width: 580px; margin: 0 auto; background-color: #0f172a !important; background: #0f172a !important; border: 1px solid #1e293b; border-radius: 24px; overflow: hidden; box-shadow: 0 20px 40px -15px rgba(0, 0, 0, 0.7); border-collapse: separate;">
          
          <!-- Header with Vibrant Gradient -->
          <tr>
            <td align="center" style="background: linear-gradient(135deg, #4338ca 0%, #6366f1 50%, #818cf8 100%); padding: 44px 32px 36px 32px; text-align: center;">
              
              <!-- Clean Logo Without Square/Border (Fixed Dimensions to Prevent Mobile Stretching) -->
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" align="center" style="margin: 0 auto 18px auto; border-collapse: collapse;">
                <tr>
                  <td align="center" style="padding: 0; border: none; background: transparent;">
                    <img src="https://images.squarespace-cdn.com/content/64d0277a0640507c114633ad/b8543df7-ec9e-4d64-912e-e80bb44c8757/Untitled+design-3.png?content-type=image%2Fpng" 
                         alt="Dental School Guide" 
                         width="64" 
                         height="64" 
                         style="display: block; width: 64px !important; max-width: 64px !important; height: 64px !important; margin: 0 auto; border: 0; outline: none; text-decoration: none;" />
                  </td>
                </tr>
              </table>

              <h1 style="color: #ffffff !important; margin: 0 0 8px 0; font-size: 28px; font-weight: 800; letter-spacing: -0.5px; text-shadow: 0 2px 4px rgba(0,0,0,0.15);">
                You're Invited! 🎉
              </h1>
              <p style="color: rgba(255, 255, 255, 0.9) !important; margin: 0; font-size: 15px; font-weight: 500; letter-spacing: 0.2px;">
                Welcome to the Dental School Guide team
              </p>
            </td>
          </tr>

          <!-- Body Content -->
          <tr>
            <td bgcolor="#0f172a" style="padding: 40px 36px; background-color: #0f172a !important; background: #0f172a !important;">
              <p style="color: #f8fafc !important; font-size: 16px; font-weight: 600; line-height: 1.6; margin: 0 0 16px 0;">
                Hi there,
              </p>
              <p style="color: #cbd5e1 !important; font-size: 15px; line-height: 1.7; margin: 0 0 18px 0;">
                You have been invited${inviterText} to join <strong style="color: #c7d2fe !important; font-weight: 700;">Dental School Guide</strong> as a <strong style="color: #a5b4fc !important; font-weight: 700;">${roleLabel}</strong> — our all-in-one platform for dental school applications, mentorship, and resources.
              </p>
              <p style="color: #94a3b8 !important; font-size: 15px; line-height: 1.7; margin: 0 0 32px 0;">
                Click the button below to choose your password and activate your account.
              </p>

              <!-- CTA Button -->
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin: 32px 0;">
                <tr>
                  <td align="center">
                    <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="border-collapse: separate;">
                      <tr>
                        <td align="center" style="border-radius: 16px; background: linear-gradient(135deg, #4f46e5 0%, #6366f1 100%); box-shadow: 0 8px 25px rgba(79, 70, 229, 0.45);">
                          <a href="${actionLink}" target="_blank" style="display: inline-block; padding: 16px 44px; font-size: 16px; font-weight: 800; color: #ffffff !important; text-decoration: none; border-radius: 16px; letter-spacing: 0.3px; border: 1px solid rgba(255,255,255,0.15);">
                            Accept Invitation &rarr;
                          </a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- Fallback Link Box -->
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="#1e293b" style="background-color: #1e293b !important; background: #1e293b !important; border: 1px solid #334155; border-radius: 12px; margin-top: 24px;">
                <tr>
                  <td style="padding: 16px; font-size: 12px; color: #94a3b8 !important; line-height: 1.6; word-break: break-all;">
                    Button not working? Copy and paste this link into your browser:<br>
                    <a href="${actionLink}" style="color: #818cf8 !important; text-decoration: underline; font-weight: 500;">${actionLink}</a>
                  </td>
                </tr>
              </table>

              <!-- Expiry Notice -->
              <p style="color: #64748b !important; font-size: 13px; line-height: 1.6; margin: 24px 0 0 0;">
                This invitation link will expire in 7 days. If you didn't expect this email, you can safely ignore it.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td bgcolor="#0b1120" style="padding: 24px 36px; border-top: 1px solid #1e293b; text-align: center; background-color: #0b1120 !important; background: #0b1120 !important;">
              <p style="color: #475569 !important; font-size: 11px; margin: 0 0 4px 0; font-weight: 700; text-transform: uppercase; letter-spacing: 1.2px;">
                Powered by
              </p>
              <p style="color: #64748b !important; font-size: 12px; margin: 0;">
                &copy; ${new Date().getFullYear()} Dental School Guide. All rights reserved.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>
`;

  try {
    const text = `
You're Invited to Dental School Guide!

Hi there,

You have been invited${inviterText} to join Dental School Guide as a ${roleLabel} — our all-in-one platform for dental school applications, mentorship, and resources.

Click the link below to choose your password and activate your account:
${actionLink}

This invitation link will expire in 7 days. If you did not expect this email, you can safely ignore it.

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
