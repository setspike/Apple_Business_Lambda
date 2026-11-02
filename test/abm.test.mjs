import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { verify } from 'node:crypto';
import {
  ASSERTION_AUDIENCE,
  apiGet,
  createClientAssertion,
  getAccessToken,
} from '../src/abm.mjs';
import { _setSecretLoader } from '../src/secret.mjs';
import {
  ACCESS_TOKEN,
  CLIENT_ID,
  KEY_ID,
  SECRET,
  SERIAL,
  decodeJwtPart,
  json,
  mockFetch,
  publicKey,
  setup,
} from './helpers.mjs';

beforeEach(setup);

test('client assertion has the expected header and claims', () => {
  const now = Date.UTC(2026, 0, 1);
  const [h, p, s] = createClientAssertion(SECRET, now).split('.');
  const header = decodeJwtPart(h);
  const claims = decodeJwtPart(p);

  assert.deepEqual(header, { alg: 'ES256', kid: KEY_ID, typ: 'JWT' });
  assert.equal(claims.iss, CLIENT_ID);
  assert.equal(claims.sub, CLIENT_ID);
  assert.equal(claims.aud, ASSERTION_AUDIENCE);
  assert.equal(claims.iat, now / 1000);
  assert.equal(claims.exp, now / 1000 + 20 * 60);
  assert.match(claims.jti, /^[0-9a-f-]{36}$/);
  // ES256 raw R||S signature is exactly 64 bytes.
  assert.equal(Buffer.from(s, 'base64url').length, 64);
});

test('client assertion signature verifies with the public key (ES256)', () => {
  const jwt = createClientAssertion(SECRET);
  const [h, p, s] = jwt.split('.');
  const ok = verify(
    'sha256',
    Buffer.from(`${h}.${p}`),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(s, 'base64url'),
  );
  assert.ok(ok);
});

test('each assertion gets a unique jti', () => {
  const a = decodeJwtPart(createClientAssertion(SECRET).split('.')[1]);
  const b = decodeJwtPart(createClientAssertion(SECRET).split('.')[1]);
  assert.notEqual(a.jti, b.jti);
});

test('token request sends the documented form parameters', async (t) => {
  const calls = mockFetch(t, {});
  await getAccessToken();

  assert.equal(calls.length, 1);
  const { init } = calls[0];
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(init.body);
  assert.equal(form.get('grant_type'), 'client_credentials');
  assert.equal(form.get('client_id'), CLIENT_ID);
  assert.equal(form.get('client_assertion_type'), 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
  assert.equal(form.get('scope'), 'business.api');
  assert.equal(form.get('client_assertion').split('.').length, 3);
});

test('ABM_SCOPE overrides the scope', async (t) => {
  process.env.ABM_SCOPE = 'school.api';
  const calls = mockFetch(t, {});
  await getAccessToken();
  assert.equal(new URLSearchParams(calls[0].init.body).get('scope'), 'school.api');
});

test('access token is cached until shortly before expiry', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  let issued = 0;
  const calls = mockFetch(t, {
    token: () => json(200, { access_token: `token-${++issued}`, expires_in: 3600 }),
  });

  assert.equal(await getAccessToken(), 'token-1');
  t.mock.timers.tick(3600_000 - 61_000); // still outside the 60 s refresh margin
  assert.equal(await getAccessToken(), 'token-1');
  assert.equal(calls.length, 1);

  t.mock.timers.tick(2_000); // now inside the margin
  assert.equal(await getAccessToken(), 'token-2');
  assert.equal(calls.length, 2);
});

test('secret is loaded once and cached', async (t) => {
  let loads = 0;
  _setSecretLoader(async () => {
    loads++;
    return JSON.stringify({ client_id: CLIENT_ID, key_id: KEY_ID, private_key_pem: SECRET.privateKeyPem });
  });
  mockFetch(t, { [`/v1/orgDevices/${SERIAL}`]: () => json(401) });
  await apiGet(`/v1/orgDevices/${SERIAL}`); // forces two token fetches
  assert.equal(loads, 1);
});

test('401 drops the cached token and retries exactly once', async (t) => {
  let issued = 0;
  let deviceCalls = 0;
  const seenAuth = [];
  const calls = mockFetch(t, {
    token: () => json(200, { access_token: `token-${++issued}`, expires_in: 3600 }),
    [`/v1/orgDevices/${SERIAL}`]: (init) => {
      seenAuth.push(init.headers.Authorization);
      return ++deviceCalls === 1 ? json(401) : json(200, { data: { id: SERIAL } });
    },
  });

  const res = await apiGet(`/v1/orgDevices/${SERIAL}`);
  assert.equal(res.status, 200);
  assert.deepEqual(seenAuth, ['Bearer token-1', 'Bearer token-2']);
  assert.equal(calls.length, 4);
});

test('a second 401 is not retried again', async (t) => {
  const calls = mockFetch(t, { [`/v1/orgDevices/${SERIAL}`]: () => json(401) });
  const res = await apiGet(`/v1/orgDevices/${SERIAL}`);
  assert.equal(res.status, 401);
  assert.equal(calls.filter((c) => c.url.includes('/orgDevices/')).length, 2);
});

test('ABM_API_BASE_URL overrides the API host', async (t) => {
  process.env.ABM_API_BASE_URL = 'https://api-school.apple.com/';
  const calls = mockFetch(t, { [`/v1/orgDevices/${SERIAL}`]: () => json(200, { data: {} }) });
  await apiGet(`/v1/orgDevices/${SERIAL}`);
  assert.equal(calls[1].url, `https://api-school.apple.com/v1/orgDevices/${SERIAL}`);
  assert.equal(calls[1].init.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
});
