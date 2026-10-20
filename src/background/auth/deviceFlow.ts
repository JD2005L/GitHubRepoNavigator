/**
 * GitHub App OAuth device flow (RFC 8628) and refresh, with no client secret.
 *
 * Runs only in the service worker: github.com's OAuth endpoints send no CORS headers, and extension contexts
 * with host permissions are exempt from CORS. Every function here is a single network step so the caller can
 * persist state between steps (the worker may be terminated at any time).
 */
import type { FetchLike } from '../github/client';

export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
/** GitHub enforces `interval` strictly; clock drift otherwise produces slow_down. */
export const POLL_MARGIN_MS = 1000;

export interface PendingFlow {
  clientId: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalS: number;
  requestedAt: number;
  expiresAt: number;
  /** When GitHub last answered a poll; the next poll must wait a full interval after it. */
  lastPollAt: number;
}

export interface TokenSet {
  clientId: string;
  accessToken: string;
  /** null when the app owner opted out of expiring user tokens. */
  expiresAt: number | null;
  refreshToken: string | null;
  refreshExpiresAt: number | null;
  obtainedAt: number;
}

export type DeviceFlowErrorCode =
  | 'expired'
  | 'denied'
  | 'bad-code'
  | 'disabled'
  | 'bad-client'
  | 'unverified-email'
  | 'network'
  | 'server'
  | 'protocol';

const MESSAGES: Record<DeviceFlowErrorCode, string> = {
  expired: 'The code expired before it was entered. Start again to get a new code.',
  denied: 'Authorization was cancelled on GitHub.',
  'bad-code': 'GitHub did not recognise this sign-in attempt. Start again to get a new code.',
  disabled: 'Device flow is not enabled for this GitHub App. Enable "Device Flow" in the app settings.',
  'bad-client': 'GitHub does not recognise the configured client ID. Check the GitHub App client ID in Options.',
  'unverified-email': 'GitHub requires a verified primary email address before authorizing apps.',
  network: 'GitHub could not be reached. Check your connection and try again.',
  server: 'GitHub had a problem completing sign-in. Try again in a moment.',
  protocol: 'GitHub returned an unexpected response during sign-in.',
};

export class DeviceFlowError extends Error {
  constructor(
    readonly code: DeviceFlowErrorCode,
    /** True when the user can simply start again; false for configuration problems. */
    readonly restartable: boolean,
  ) {
    super(MESSAGES[code]);
    this.name = 'DeviceFlowError';
  }
}

interface OAuthReply {
  status: number;
  body: Record<string, unknown>;
}

async function postOAuth(fetchImpl: FetchLike, url: string, params: Record<string, string>): Promise<OAuthReply> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      credentials: 'omit', // never attach the user's github.com session cookies
      cache: 'no-store',
      redirect: 'manual',
    });
  } catch {
    throw new DeviceFlowError('network', true);
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: response.status, body };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length < 2048 ? value : null;
}

function positive(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : fallback;
}

const USER_CODE_RE = /^[A-Z0-9]{4}-?[A-Z0-9]{4}$/i;

export async function requestDeviceCode(fetchImpl: FetchLike, oauthBase: string, clientId: string, now: number): Promise<PendingFlow> {
  const { status, body } = await postOAuth(fetchImpl, `${oauthBase}/login/device/code`, { client_id: clientId });
  if (status === 404) throw new DeviceFlowError('bad-client', false); // unknown client_id -> 404 {"error":"Not Found"}
  const error = str(body.error);
  if (error === 'device_flow_disabled') throw new DeviceFlowError('disabled', false);
  if (error === 'incorrect_client_credentials' || error === 'Not Found') throw new DeviceFlowError('bad-client', false);
  if (error || status !== 200) throw new DeviceFlowError(status === 429 || status >= 500 ? 'server' : 'protocol', true);
  const deviceCode = str(body.device_code);
  const userCode = str(body.user_code);
  const verificationUri = str(body.verification_uri);
  if (!deviceCode || !userCode || !USER_CODE_RE.test(userCode) || !verificationUri) throw new DeviceFlowError('protocol', true);
  // Only ever send the user to GitHub's own verification page.
  let verification: URL;
  try {
    verification = new URL(verificationUri);
  } catch {
    throw new DeviceFlowError('protocol', true);
  }
  if (verification.protocol !== 'https:' || verification.hostname !== 'github.com') throw new DeviceFlowError('protocol', true);
  const intervalS = positive(body.interval, 5);
  return {
    clientId,
    deviceCode,
    userCode: userCode.toUpperCase(),
    verificationUri: verification.toString(),
    intervalS,
    requestedAt: now,
    expiresAt: now + positive(body.expires_in, 900) * 1000,
    lastPollAt: now,
  };
}

export function tokenSetFrom(body: Record<string, unknown>, clientId: string, now: number): TokenSet | null {
  const accessToken = str(body.access_token);
  if (!accessToken) return null;
  const expiresIn = typeof body.expires_in === 'number' || typeof body.expires_in === 'string' ? positive(body.expires_in, 0) : 0;
  const refreshIn = typeof body.refresh_token_expires_in === 'number' || typeof body.refresh_token_expires_in === 'string' ? positive(body.refresh_token_expires_in, 0) : 0;
  const refreshToken = str(body.refresh_token);
  return {
    clientId,
    accessToken,
    expiresAt: expiresIn ? now + expiresIn * 1000 : null,
    refreshToken,
    refreshExpiresAt: refreshToken && refreshIn ? now + refreshIn * 1000 : null,
    obtainedAt: now,
  };
}

export type PollResult = { kind: 'pending'; intervalS: number } | { kind: 'token'; token: TokenSet };

/** One poll. Returns the interval to wait before the next poll (raised permanently on slow_down). */
export async function pollDeviceToken(fetchImpl: FetchLike, oauthBase: string, flow: PendingFlow, now: number): Promise<PollResult> {
  if (now >= flow.expiresAt) throw new DeviceFlowError('expired', true);
  let reply: OAuthReply;
  try {
    reply = await postOAuth(fetchImpl, `${oauthBase}/login/oauth/access_token`, {
      client_id: flow.clientId,
      device_code: flow.deviceCode,
      grant_type: DEVICE_GRANT,
    });
  } catch (error) {
    // A network blip (Wi-Fi switch, VPN) must not end a sign-in the user is completing on github.com.
    if (error instanceof DeviceFlowError && error.code === 'network') return { kind: 'pending', intervalS: flow.intervalS + 5 };
    throw error;
  }
  const error = str(reply.body.error);
  if (!error && reply.status === 200) {
    const token = tokenSetFrom(reply.body, flow.clientId, now);
    if (!token) throw new DeviceFlowError('protocol', true);
    return { kind: 'token', token };
  }
  switch (error) {
    case 'authorization_pending':
      return { kind: 'pending', intervalS: flow.intervalS };
    case 'slow_down':
      return { kind: 'pending', intervalS: Math.max(positive(reply.body.interval, 0), flow.intervalS + 5) };
    case 'expired_token':
    case 'token_expired':
      throw new DeviceFlowError('expired', true);
    case 'access_denied':
      throw new DeviceFlowError('denied', true);
    case 'incorrect_device_code':
    case 'bad_verification_code':
      throw new DeviceFlowError('bad-code', true);
    case 'device_flow_disabled':
      throw new DeviceFlowError('disabled', false);
    case 'incorrect_client_credentials':
    case 'unsupported_grant_type':
      throw new DeviceFlowError('bad-client', false);
    case 'unverified_user_email':
      throw new DeviceFlowError('unverified-email', false);
    default:
      // Transient server trouble: keep polling at a slower pace until the deadline.
      if (reply.status === 429 || reply.status >= 500) return { kind: 'pending', intervalS: flow.intervalS + 5 };
      if (reply.status === 404) throw new DeviceFlowError('bad-client', false);
      throw new DeviceFlowError('protocol', true);
  }
}

export type RefreshResult = { kind: 'token'; token: TokenSet } | { kind: 'rejected' } | { kind: 'transient' };

/**
 * Refreshes a device-flow token without a client secret (GitHub documents client_secret as "required unless the
 * user access token was generated using the device flow"). The old pair stops working once GitHub answers, so
 * the caller must persist the new pair before using it.
 */
export async function refreshUserToken(fetchImpl: FetchLike, oauthBase: string, clientId: string, refreshToken: string, now: number): Promise<RefreshResult> {
  let reply: OAuthReply;
  try {
    reply = await postOAuth(fetchImpl, `${oauthBase}/login/oauth/access_token`, {
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
  } catch {
    return { kind: 'transient' };
  }
  if (reply.status === 429 || reply.status >= 500) return { kind: 'transient' };
  if (str(reply.body.error) || reply.status !== 200) return { kind: 'rejected' };
  const token = tokenSetFrom(reply.body, clientId, now);
  return token ? { kind: 'token', token } : { kind: 'rejected' };
}
