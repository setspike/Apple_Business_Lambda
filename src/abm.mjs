// Apple Business API client: client-assertion JWT, OAuth token, and device lookups.
// Docs: https://developer.apple.com/documentation/apple-school-and-business-manager-api

import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { getAbmSecret } from './secret.mjs';

export const TOKEN_URL = 'https://account.apple.com/auth/oauth2/token';
export const ASSERTION_AUDIENCE = 'https://account.apple.com/auth/oauth2/v2/token';
const ASSERTION_TTL_SECONDS = 20 * 60;
const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 4000;

export const RELATED_RESOURCES = ['assignedServer', 'appleCareCoverage'];

// Raised for any failure talking to Apple. `status` is the upstream HTTP
// status when there was one. The message never contains credentials.
export class UpstreamError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
  }
}

let tokenCache; // { accessToken, expiresAt }

const b64url = (value) => Buffer.from(value).toString('base64url');

export function createClientAssertion({ clientId, keyId, privateKeyPem }, nowMs = Date.now()) {
  const iat = Math.floor(nowMs / 1000);
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const claims = {
    iss: clientId,
    sub: clientId,
    aud: ASSERTION_AUDIENCE,
    iat,
    exp: iat + ASSERTION_TTL_SECONDS,
    jti: randomUUID(),
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = sign('sha256', Buffer.from(signingInput), {
    key: createPrivateKey(privateKeyPem),
    dsaEncoding: 'ieee-p1363', // raw R||S, as JWS requires
  });
  return `${signingInput}.${signature.toString('base64url')}`;
}

async function request(url, init) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw new UpstreamError('Upstream request failed', undefined);
  }
}

export async function getAccessToken() {
  if (tokenCache && Date.now() < tokenCache.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
    return tokenCache.accessToken;
  }

  const secret = await getAbmSecret();
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: secret.clientId,
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: createClientAssertion(secret),
    scope: process.env.ABM_SCOPE || 'business.api',
  });

  const res = await request(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  if (!res.ok) throw new UpstreamError('Token request failed', res.status);

  const json = await res.json().catch(() => ({}));
  if (typeof json.access_token !== 'string') {
    throw new UpstreamError('Token response missing access_token', res.status);
  }
  const expiresIn = Number(json.expires_in) || 3600;
  tokenCache = { accessToken: json.access_token, expiresAt: Date.now() + expiresIn * 1000 };
  return tokenCache.accessToken;
}

export function clearTokenCache() {
  tokenCache = undefined;
}

function apiBaseUrl() {
  return (process.env.ABM_API_BASE_URL || 'https://api-business.apple.com').replace(/\/+$/, '');
}

// GET an API path. On 401 the cached token is dropped and the call retried once.
// Resolves to { status, body }; body is parsed JSON for 2xx responses only.
export async function apiGet(path) {
  for (let attempt = 0; ; attempt++) {
    const token = await getAccessToken();
    const res = await request(`${apiBaseUrl()}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (res.status === 401 && attempt === 0) {
      clearTokenCache();
      continue;
    }
    if (!res.ok) return { status: res.status };
    try {
      return { status: res.status, body: await res.json() };
    } catch {
      throw new UpstreamError('Upstream returned invalid JSON', res.status);
    }
  }
}

// Looks up a device and, optionally, related resources.
// Resolves to { status, body } where status is Apple's status for the device call.
export async function lookupDevice(serial, include = []) {
  const devicePath = `/v1/orgDevices/${encodeURIComponent(serial)}`;
  const device = await apiGet(devicePath);
  if (device.status === 404) return { status: 404 };
  if (!device.body) throw new UpstreamError('Device lookup failed', device.status);

  const related = await Promise.all(
    include.map(async (name) => {
      const res = await apiGet(`${devicePath}/${name}`);
      if (res.status === 404) return [name, null];
      if (!res.body) throw new UpstreamError(`${name} lookup failed`, res.status);
      return [name, res.body];
    }),
  );

  return { status: device.status, body: { ...device.body, ...Object.fromEntries(related) } };
}
