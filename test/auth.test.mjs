import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handler } from '../src/index.mjs';
import { SERIAL, enableTokenAuth, json, mockFetch, setup } from './helpers.mjs';

// Throwaway test values, not real tokens.
const TOKEN = 'test-bearer-token-0000000000000000000000000000';
const OLD_TOKEN = 'test-bearer-token-old-000000000000000000000000';
const DEVICE = { data: { type: 'orgDevices', id: SERIAL } };
const ctx = { awsRequestId: 'req-0000' };

const urlEvent = (headers = {}) => ({
  requestContext: { http: { method: 'GET' } },
  headers,
  queryStringParameters: { serial: SERIAL },
});

const tokenSecret = (body) => () => JSON.stringify(body);

beforeEach(setup);

test('without AUTH_TOKEN_SECRET_ID, URL requests need no token', async (t) => {
  mockFetch(t, { [`/v1/orgDevices/${SERIAL}`]: () => json(200, DEVICE) });
  assert.equal((await handler(urlEvent(), ctx)).statusCode, 200);
});

test('missing Authorization header is rejected with 401 before any Apple call', async (t) => {
  enableTokenAuth(tokenSecret({ token: TOKEN }));
  const calls = mockFetch(t, {});
  const res = await handler(urlEvent(), ctx);
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers['WWW-Authenticate'], 'Bearer');
  assert.deepEqual(JSON.parse(res.body), { error: 'Unauthorized' });
  assert.equal(calls.length, 0);
});

test('wrong, malformed or non-Bearer credentials are rejected', async (t) => {
  enableTokenAuth(tokenSecret({ token: TOKEN }));
  const calls = mockFetch(t, {});
  const bad = [
    `Bearer ${TOKEN}x`,
    `Bearer ${TOKEN.slice(0, -1)}`,
    'Bearer',
    `Bearer ${TOKEN} extra`,
    `Basic ${TOKEN}`,
    TOKEN,
    '',
  ];
  for (const authorization of bad) {
    const res = await handler(urlEvent({ authorization }), ctx);
    assert.equal(res.statusCode, 401, `authorization ${JSON.stringify(authorization.slice(0, 10))}`);
  }
  assert.equal(calls.length, 0);
});

test('a valid token is accepted, case-insensitively for the scheme', async (t) => {
  enableTokenAuth(tokenSecret({ token: TOKEN }));
  mockFetch(t, { [`/v1/orgDevices/${SERIAL}`]: () => json(200, DEVICE) });
  assert.equal((await handler(urlEvent({ authorization: `Bearer ${TOKEN}` }), ctx)).statusCode, 200);
  assert.equal((await handler(urlEvent({ authorization: `bearer ${TOKEN}` }), ctx)).statusCode, 200);
  assert.equal((await handler(urlEvent({ Authorization: `Bearer ${TOKEN}` }), ctx)).statusCode, 200);
});

test('previous_token is also accepted during rotation', async (t) => {
  enableTokenAuth(tokenSecret({ token: TOKEN, previous_token: OLD_TOKEN }));
  mockFetch(t, { [`/v1/orgDevices/${SERIAL}`]: () => json(200, DEVICE) });
  assert.equal((await handler(urlEvent({ authorization: `Bearer ${OLD_TOKEN}` }), ctx)).statusCode, 200);
  assert.equal((await handler(urlEvent({ authorization: `Bearer ${TOKEN}` }), ctx)).statusCode, 200);
});

test('token checks run before input validation', async (t) => {
  enableTokenAuth(tokenSecret({ token: TOKEN }));
  mockFetch(t, {});
  const res = await handler({ ...urlEvent(), queryStringParameters: { serial: 'bad' } }, ctx);
  assert.equal(res.statusCode, 401);
});

test('direct invokes are not token-checked (they require IAM invoke permission)', async (t) => {
  enableTokenAuth(tokenSecret({ token: TOKEN }));
  mockFetch(t, { [`/v1/orgDevices/${SERIAL}`]: () => json(200, DEVICE) });
  assert.equal((await handler({ serial: SERIAL }, ctx)).statusCode, 200);
});

test('fails closed with 502 when the token secret is unreadable or invalid', async (t) => {
  const calls = mockFetch(t, {});
  const broken = [
    () => {
      throw new Error('AccessDeniedException');
    },
    () => 'not json',
    tokenSecret({}),
    tokenSecret({ token: 'too-short' }),
    tokenSecret({ token: TOKEN, previous_token: 'too-short' }),
    tokenSecret({ token: 12345 }),
  ];
  for (const secret of broken) {
    setup();
    enableTokenAuth(secret);
    const res = await handler(urlEvent({ authorization: `Bearer ${TOKEN}` }), ctx);
    assert.equal(res.statusCode, 502);
  }
  assert.equal(calls.length, 0);
});

test('token secret is re-read after 5 minutes so rotation takes effect', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  let current = { token: OLD_TOKEN };
  let reads = 0;
  enableTokenAuth(() => {
    reads++;
    return JSON.stringify(current);
  });
  mockFetch(t, { [`/v1/orgDevices/${SERIAL}`]: () => json(200, DEVICE) });

  assert.equal((await handler(urlEvent({ authorization: `Bearer ${OLD_TOKEN}` }), ctx)).statusCode, 200);
  current = { token: TOKEN };
  t.mock.timers.tick(4 * 60 * 1000); // still cached
  assert.equal((await handler(urlEvent({ authorization: `Bearer ${TOKEN}` }), ctx)).statusCode, 401);
  t.mock.timers.tick(2 * 60 * 1000); // cache expired
  assert.equal((await handler(urlEvent({ authorization: `Bearer ${TOKEN}` }), ctx)).statusCode, 200);
  assert.equal((await handler(urlEvent({ authorization: `Bearer ${OLD_TOKEN}` }), ctx)).statusCode, 401);
  assert.equal(reads, 2);
});

test('tokens never appear in logs or responses', async (t) => {
  const lines = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    t.mock.method(console, level, (...args) => lines.push(args.map(String).join(' ')));
  }
  enableTokenAuth(tokenSecret({ token: TOKEN, previous_token: OLD_TOKEN }));
  mockFetch(t, { [`/v1/orgDevices/${SERIAL}`]: () => json(200, DEVICE) });

  const bodies = [];
  for (const authorization of [`Bearer ${TOKEN}`, `Bearer ${OLD_TOKEN}`, `Bearer ${TOKEN}x`, '']) {
    bodies.push(JSON.stringify(await handler(urlEvent({ authorization }), ctx)));
  }
  const output = [...lines, ...bodies].join('\n');
  for (const value of [TOKEN, OLD_TOKEN]) {
    assert.ok(!output.includes(value), 'token leaked');
  }
  assert.ok(lines.some((l) => JSON.parse(l).auth === 'rejected'));
});
