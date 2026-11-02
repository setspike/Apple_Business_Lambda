// Shared test fixtures. The EC key is generated fresh for every test run and
// never written to disk.

import { generateKeyPairSync } from 'node:crypto';
import { _setSecretLoader } from '../src/secret.mjs';
import { clearTokenCache } from '../src/abm.mjs';

export const CLIENT_ID = 'BUSINESSAPI.00000000-0000-0000-0000-000000000000';
export const KEY_ID = '00000000-0000-0000-0000-000000000000';
export const SERIAL = 'C02XXXXXXXXX';
export const ACCESS_TOKEN = 'test-access-token-do-not-log';

export const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
export const PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

export const SECRET = { clientId: CLIENT_ID, keyId: KEY_ID, privateKeyPem: PRIVATE_KEY_PEM };

export function decodeJwtPart(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

export const json = (status, body) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

// Installs a fake fetch. `routes` maps a URL suffix (or 'token') to a function
// returning a Response; every call is recorded in the returned array.
export function mockFetch(t, routes) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url) === 'https://account.apple.com/auth/oauth2/token') {
      return (routes.token ?? (() => json(200, { access_token: ACCESS_TOKEN, expires_in: 3600 })))(init);
    }
    const path = new URL(url).pathname;
    const route = routes[path];
    if (!route) throw new Error(`Unexpected fetch: ${url}`);
    return route(init);
  });
  return calls;
}

export function setup() {
  process.env.ABM_SECRET_ID = 'abm/test-secret';
  delete process.env.ABM_SCOPE;
  delete process.env.ABM_API_BASE_URL;
  _setSecretLoader(async () =>
    JSON.stringify({ client_id: CLIENT_ID, key_id: KEY_ID, private_key_pem: PRIVATE_KEY_PEM }),
  );
  clearTokenCache();
}
