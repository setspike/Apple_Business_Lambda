import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handler } from '../src/index.mjs';
import { _setSecretLoader } from '../src/secret.mjs';
import {
  ACCESS_TOKEN,
  KEY_ID,
  PRIVATE_KEY_PEM,
  SERIAL,
  json,
  mockFetch,
  setup,
} from './helpers.mjs';

beforeEach(setup);

const DEVICE = { data: { type: 'orgDevices', id: SERIAL, attributes: { serialNumber: SERIAL } } };
const DEVICE_PATH = `/v1/orgDevices/${SERIAL}`;
const ctx = { awsRequestId: 'req-0000' };

const urlEvent = (query, method = 'GET') => ({
  requestContext: { http: { method } },
  queryStringParameters: query,
});

function captureLogs(t) {
  const lines = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    t.mock.method(console, level, (...args) => lines.push(args.map(String).join(' ')));
  }
  return lines;
}

test('rejects invalid serials with 400 before any network call', async (t) => {
  const calls = mockFetch(t, {});
  const bad = [undefined, '', 'c02xxxxxxxxx', 'C02XXX', 'C02XXXXXXXXXXXX', 'C02-XXXXXXXX', 'C02 XXXXXXXX', 12345678, '../../token'];
  for (const serial of bad) {
    const res = await handler(urlEvent(serial === undefined ? undefined : { serial }), ctx);
    assert.equal(res.statusCode, 400, `serial ${JSON.stringify(serial)}`);
    const direct = await handler({ serial }, ctx);
    assert.equal(direct.statusCode, 400, `direct serial ${JSON.stringify(serial)}`);
  }
  assert.equal(calls.length, 0);
});

test('accepts serials of 8 and 14 characters', async (t) => {
  mockFetch(t, {
    '/v1/orgDevices/ABCD1234': () => json(200, DEVICE),
    '/v1/orgDevices/ABCDEFGH123456': () => json(200, DEVICE),
  });
  assert.equal((await handler({ serial: 'ABCD1234' }, ctx)).statusCode, 200);
  assert.equal((await handler({ serial: 'ABCDEFGH123456' }, ctx)).statusCode, 200);
});

test('rejects unknown include values with 400', async (t) => {
  const calls = mockFetch(t, {});
  const res = await handler(urlEvent({ serial: SERIAL, include: 'assignedServer,token' }), ctx);
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
});

test('rejects non-GET Function URL requests', async (t) => {
  mockFetch(t, {});
  const res = await handler(urlEvent({ serial: SERIAL }, 'POST'), ctx);
  assert.equal(res.statusCode, 405);
});

test('returns Apple JSON with 200 via Function URL', async (t) => {
  mockFetch(t, { [DEVICE_PATH]: () => json(200, DEVICE) });
  const res = await handler(urlEvent({ serial: SERIAL }), ctx);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), DEVICE);
});

test('returns Apple JSON with 200 via direct invoke', async (t) => {
  mockFetch(t, { [DEVICE_PATH]: () => json(200, DEVICE) });
  const res = await handler({ serial: SERIAL }, ctx);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), DEVICE);
});

test('maps Apple 404 to 404', async (t) => {
  mockFetch(t, { [DEVICE_PATH]: () => json(404, { errors: [{ status: '404' }] }) });
  const res = await handler({ serial: SERIAL }, ctx);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(JSON.parse(res.body), { error: 'Device not found' });
});

test('maps upstream failures to a generic 502', async (t) => {
  for (const status of [403, 429, 500]) {
    mockFetch(t, { [DEVICE_PATH]: () => json(status, { errors: [{ detail: 'upstream detail' }] }) });
    const res = await handler({ serial: SERIAL }, ctx);
    assert.equal(res.statusCode, 502);
    assert.deepEqual(JSON.parse(res.body), { error: 'Upstream request failed' });
    t.mock.restoreAll();
  }
});

test('maps token endpoint failure to 502', async (t) => {
  mockFetch(t, { token: () => json(400, { error: 'invalid_client' }) });
  const res = await handler({ serial: SERIAL }, ctx);
  assert.equal(res.statusCode, 502);
});

test('maps network errors to 502', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('fetch failed');
  });
  const res = await handler({ serial: SERIAL }, ctx);
  assert.equal(res.statusCode, 502);
});

test('maps secret load failure to 502', async (t) => {
  mockFetch(t, {});
  _setSecretLoader(async () => {
    throw new Error('AccessDeniedException');
  });
  const res = await handler({ serial: SERIAL }, ctx);
  assert.equal(res.statusCode, 502);
});

test('include merges related resources into the response', async (t) => {
  const server = { data: { type: 'mdmServers', id: 'server-1' } };
  const coverage = { data: [{ type: 'appleCareCoverage', id: 'cov-1' }] };
  mockFetch(t, {
    [DEVICE_PATH]: () => json(200, DEVICE),
    [`${DEVICE_PATH}/assignedServer`]: () => json(200, server),
    [`${DEVICE_PATH}/appleCareCoverage`]: () => json(200, coverage),
  });
  const res = await handler(urlEvent({ serial: SERIAL, include: 'assignedServer,appleCareCoverage' }), ctx);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ...DEVICE, assignedServer: server, appleCareCoverage: coverage });
});

test('include accepts an array on direct invoke and maps a related 404 to null', async (t) => {
  mockFetch(t, {
    [DEVICE_PATH]: () => json(200, DEVICE),
    [`${DEVICE_PATH}/assignedServer`]: () => json(404),
  });
  const res = await handler({ serial: SERIAL, include: ['assignedServer'] }, ctx);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).assignedServer, null);
});

test('logs only request id, serial and upstream status', async (t) => {
  const lines = captureLogs(t);
  mockFetch(t, { [DEVICE_PATH]: () => json(200, DEVICE) });
  await handler({ serial: SERIAL }, ctx);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { requestId: 'req-0000', serial: SERIAL, upstreamStatus: 200 });
});

test('no secret material, token or assertion appears in logs or responses', async (t) => {
  const lines = captureLogs(t);
  const assertions = [];
  const scenarios = [
    { [DEVICE_PATH]: () => json(200, DEVICE) },
    { [DEVICE_PATH]: () => json(404) },
    { [DEVICE_PATH]: () => json(500) },
    { [DEVICE_PATH]: () => json(401) },
    { token: () => json(401, { error: 'invalid_client' }) },
  ];
  const bodies = [];
  for (const routes of scenarios) {
    setup();
    const calls = mockFetch(t, routes);
    bodies.push(JSON.stringify(await handler(urlEvent({ serial: SERIAL, include: 'assignedServer' }), ctx)));
    for (const c of calls) {
      if (c.init.method === 'POST') assertions.push(new URLSearchParams(c.init.body).get('client_assertion'));
    }
    t.mock.restoreAll();
    for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
      t.mock.method(console, level, (...args) => lines.push(args.map(String).join(' ')));
    }
  }

  const output = [...lines, ...bodies].join('\n');
  const pemBody = PRIVATE_KEY_PEM.split('\n').filter((l) => l && !l.startsWith('-----')).join('');
  const forbidden = [ACCESS_TOKEN, KEY_ID, 'PRIVATE KEY', pemBody.slice(0, 40), ...assertions];
  assert.ok(assertions.length > 0);
  for (const value of forbidden) {
    assert.ok(!output.includes(value), `output leaked: ${value.slice(0, 12)}...`);
  }
});
