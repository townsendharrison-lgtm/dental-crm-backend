/**
 * Supabase Auth → Email → "Email OTP Expiration" is the real lifetime of an invite.
 * The dashboard allows 60–86400 seconds (24 hours). Our record must not end sooner
 * than that setting, or the admin list marks a still-valid link as expired.
 *
 * Set SUPABASE_OTP_EXP_SECONDS to the same number as the Supabase dashboard.
 * When it is unset, use the dashboard maximum so we never cut the link off early.
 */
export function supabaseOtpExpSeconds(): number {
  const raw = process.env.SUPABASE_OTP_EXP_SECONDS || process.env.GOTRUE_MAILER_OTP_EXP || '';
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= 60) return Math.min(Math.floor(parsed), 86400);
  return 86400;
}

export function inviteExpiresAt(from = new Date()): Date {
  return new Date(from.getTime() + supabaseOtpExpSeconds() * 1000);
}

export function formatInviteLifetime(seconds = supabaseOtpExpSeconds()): string {
  if (seconds % 86400 === 0) {
    const days = seconds / 86400;
    return days === 1 ? '24 hours' : `${days} days`;
  }
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/**
 * Link to our own page. The Supabase verify URL is one-time and gets used up
 * when an inbox scanner opens it. This URL does nothing until the person clicks
 * Continue, which is when we redeem the token.
 */
export function buildSafeInviteUrl(frontendUrl: string, hashedToken: string, type: string): string {
  const url = new URL('/complete-invitation', frontendUrl.endsWith('/') ? frontendUrl : `${frontendUrl}/`);
  url.searchParams.set('token_hash', hashedToken);
  url.searchParams.set('type', type || 'invite');
  return url.toString();
}
