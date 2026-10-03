import { Router, Request, Response } from 'express';
import { completeConnect } from '../services/google/googleAuth.js';

const router = Router();

const DEFAULT_RETURN = '/admin/rules-engine?tab=platform';

export function googleOAuthRedirectUri(req: Request): string {
  const configured = process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim();
  if (configured) return configured;
  return `${req.protocol}://${req.get('host')}/api/google-oauth/callback`;
}

function frontendUrl(path: string, params: Record<string, string>): string {
  const base = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  const safePath = path.startsWith('/') && !path.startsWith('//') ? path : DEFAULT_RETURN;
  const url = new URL(safePath, base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

// ─── GET /api/google-oauth/callback ──────────────────────────────────
// Google redirects here after the DSG admin approves access (no CRM auth header available).
router.get('/callback', async (req: Request, res: Response) => {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const oauthError = typeof req.query.error === 'string' ? req.query.error : '';

  if (oauthError || !code || !state) {
    return res.redirect(
      frontendUrl(DEFAULT_RETURN, { google: 'error', message: oauthError || 'Sign-in was cancelled' }),
    );
  }
  try {
    const { email, returnTo } = await completeConnect(googleOAuthRedirectUri(req), code, state);
    res.redirect(frontendUrl(returnTo || DEFAULT_RETURN, { google: 'connected', account: email }));
  } catch (err: any) {
    console.error('Google OAuth callback error:', err);
    res.redirect(
      frontendUrl(DEFAULT_RETURN, {
        google: 'error',
        message: String(err?.message || 'Google connection failed').slice(0, 300),
      }),
    );
  }
});

export const googleOAuthRouter = router;
