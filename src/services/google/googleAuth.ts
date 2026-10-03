import crypto from 'node:crypto';
import { JWT, OAuth2Client } from 'google-auth-library';
import { supabaseAdmin } from '../../config/supabase.js';

/**
 * All Google calls run as the central DSG Workspace account
 * (GOOGLE_DSG_USER_EMAIL, default info@dentalschoolguide.com).
 *
 * Credential sources, in priority order:
 *  1. Service account with domain-wide delegation: GOOGLE_SERVICE_ACCOUNT_JSON (raw JSON or base64)
 *  2. Refresh token in env: GOOGLE_DSG_REFRESH_TOKEN
 *  3. Refresh token saved by the "Connect Google account" button (public.google_integration)
 * Modes 2 and 3 need GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET.
 */

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/meetings.space.created',
  'https://www.googleapis.com/auth/meetings.space.settings',
  'https://www.googleapis.com/auth/meetings.space.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive.readonly',
];

const CONNECT_SCOPES = [...GOOGLE_SCOPES, 'openid', 'email'];
const STATE_TTL_MS = 15 * 60 * 1000;

export class GoogleApiError extends Error {
  status: number;
  details: unknown;
  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'GoogleApiError';
    this.status = status;
    this.details = details;
  }
}

type RequestClient = OAuth2Client | JWT;
export type GoogleAuthMode = 'service_account' | 'oauth_env' | 'oauth_connected';

let cachedClient: RequestClient | null = null;
let storedRefreshToken: string | null = null;
let storedAccountEmail: string | null = null;
let storedConnectedAt: string | null = null;

export function dsgUserEmail(): string {
  return (process.env.GOOGLE_DSG_USER_EMAIL || 'info@dentalschoolguide.com').trim();
}

function hasOAuthClient(): boolean {
  return !!(process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() && process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim());
}

export function authMode(): GoogleAuthMode | null {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim()) return 'service_account';
  if (hasOAuthClient() && process.env.GOOGLE_DSG_REFRESH_TOKEN?.trim()) return 'oauth_env';
  if (hasOAuthClient() && storedRefreshToken) return 'oauth_connected';
  return null;
}

export function googleMeetEnabled(): boolean {
  return (process.env.GOOGLE_MEET_ENABLED || '').toLowerCase() === 'true' && authMode() !== null;
}

export function connectedAccount() {
  return storedRefreshToken
    ? { email: storedAccountEmail, connectedAt: storedConnectedAt }
    : null;
}

export function canConnectViaBrowser(): boolean {
  return hasOAuthClient();
}

// ─── Encryption / signed state ───────────────────────────────────────

function secretKey(): Buffer {
  const material =
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY ||
    process.env.JWT_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    '';
  if (!material) throw new Error('Set GOOGLE_TOKEN_ENCRYPTION_KEY (or JWT_SECRET) to store Google tokens');
  return crypto.createHash('sha256').update(material).digest();
}

function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

function decrypt(payload: string): string {
  const [iv, tag, enc] = payload.split('.').map((p) => Buffer.from(p, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

function signState(data: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = crypto.createHmac('sha256', secretKey()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyState(state: string): { uid: string; returnTo: string } {
  const [body, sig] = state.split('.');
  if (!body || !sig) throw new Error('Invalid state');
  const expected = crypto.createHmac('sha256', secretKey()).update(body).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw new Error('Invalid state signature');
  }
  const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (!data.exp || Date.now() > data.exp) throw new Error('Sign-in link expired, try again');
  return { uid: data.uid, returnTo: data.returnTo };
}

// ─── Stored (browser-connected) refresh token ────────────────────────

/** Load the refresh token saved via the Connect button. Call once at startup. */
export async function initGoogleAuth(): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin
      .from('google_integration')
      .select('account_email, refresh_token_enc, connected_at')
      .eq('id', 1)
      .maybeSingle();
    if (error) {
      if (!/does not exist|schema cache/i.test(error.message)) {
        console.error('Google integration load error:', error.message);
      }
      return;
    }
    if (!data) return;
    storedRefreshToken = decrypt(data.refresh_token_enc);
    storedAccountEmail = data.account_email;
    storedConnectedAt = data.connected_at;
    cachedClient = null;
  } catch (err) {
    console.error('Google integration decrypt failed (encryption key changed?):', err);
  }
}

function oauthClient(redirectUri?: string): OAuth2Client {
  return new OAuth2Client(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri,
  );
}

export function buildConnectUrl(redirectUri: string, userId: string, returnTo: string): string {
  if (!hasOAuthClient()) throw new Error('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET are not set');
  const state = signState({
    uid: userId,
    returnTo,
    exp: Date.now() + STATE_TTL_MS,
    n: crypto.randomBytes(8).toString('hex'),
  });
  return oauthClient(redirectUri).generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: false,
    scope: CONNECT_SCOPES,
    login_hint: dsgUserEmail(),
    state,
  });
}

/** Exchange the OAuth code, verify it is the DSG account, persist the refresh token. */
export async function completeConnect(
  redirectUri: string,
  code: string,
  state: string,
): Promise<{ email: string; returnTo: string }> {
  const { uid, returnTo } = verifyState(state);
  const client = oauthClient(redirectUri);
  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) throw new Error('Google did not return an identity token');

  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: process.env.GOOGLE_OAUTH_CLIENT_ID,
  });
  const email = (ticket.getPayload()?.email || '').toLowerCase();
  if (email !== dsgUserEmail().toLowerCase()) {
    throw new Error(`Signed in as ${email || 'unknown'}; please sign in as ${dsgUserEmail()}`);
  }
  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and connect again.',
    );
  }
  const granted = new Set((tokens.scope || '').split(' '));
  const missing = GOOGLE_SCOPES.filter((s) => !granted.has(s));
  if (missing.length) {
    throw new Error(`Some permissions were not granted (tick every checkbox): ${missing.join(', ')}`);
  }

  const { error } = await supabaseAdmin.from('google_integration').upsert({
    id: 1,
    account_email: email,
    refresh_token_enc: encrypt(tokens.refresh_token),
    scopes: tokens.scope || null,
    connected_by: uid || null,
    connected_at: new Date().toISOString(),
  });
  if (error) throw new Error(`Saving Google connection failed: ${error.message}`);

  storedRefreshToken = tokens.refresh_token;
  storedAccountEmail = email;
  storedConnectedAt = new Date().toISOString();
  cachedClient = null;
  return { email, returnTo };
}

export async function disconnectGoogle(): Promise<void> {
  const token = storedRefreshToken;
  await supabaseAdmin.from('google_integration').delete().eq('id', 1);
  storedRefreshToken = null;
  storedAccountEmail = null;
  storedConnectedAt = null;
  cachedClient = null;
  if (token) await oauthClient().revokeToken(token).catch(() => undefined);
}

// ─── Authenticated requests ──────────────────────────────────────────

function parseServiceAccount(raw: string): { client_email: string; private_key: string } {
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const json = JSON.parse(text);
  if (!json.client_email || !json.private_key) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email/private_key');
  }
  return json;
}

function getClient(): RequestClient {
  if (cachedClient) return cachedClient;
  const mode = authMode();
  if (mode === 'service_account') {
    const sa = parseServiceAccount(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!);
    cachedClient = new JWT({
      email: sa.client_email,
      key: sa.private_key,
      scopes: GOOGLE_SCOPES,
      subject: dsgUserEmail(),
    });
  } else if (mode === 'oauth_env' || mode === 'oauth_connected') {
    const client = oauthClient();
    client.setCredentials({
      refresh_token:
        mode === 'oauth_env' ? process.env.GOOGLE_DSG_REFRESH_TOKEN : storedRefreshToken!,
    });
    cachedClient = client;
  } else {
    throw new Error('Google account is not connected');
  }
  return cachedClient;
}

export interface GoogleRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  data?: unknown;
  params?: Record<string, string | number | boolean | undefined>;
  responseType?: 'json' | 'text';
}

export async function googleRequest<T = any>(
  url: string,
  opts: GoogleRequestOptions = {},
): Promise<T> {
  const client = getClient();
  const params = opts.params
    ? Object.fromEntries(Object.entries(opts.params).filter(([, v]) => v !== undefined))
    : undefined;
  try {
    const res = await client.request<T>({
      url,
      method: opts.method || 'GET',
      data: opts.data,
      params,
      responseType: opts.responseType || 'json',
    });
    return res.data;
  } catch (err: any) {
    const status = err?.response?.status ?? 0;
    const body = err?.response?.data;
    const msg =
      body?.error?.message ||
      body?.error_description ||
      (typeof body === 'string' ? body : null) ||
      err?.message ||
      'Google API request failed';
    throw new GoogleApiError(`${status || 'ERR'} ${msg}`, status, body);
  }
}
