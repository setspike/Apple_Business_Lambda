// Lambda handler: look up an Apple Business device by serial number.
// Invoked through a Function URL (GET ?serial=...&include=...) or directly
// with { "serial": "...", "include": [...] }.

import { lookupDevice, RELATED_RESOURCES, UpstreamError } from './abm.mjs';

const SERIAL_PATTERN = /^[A-Z0-9]{8,14}$/;

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function log(fields) {
  console.log(JSON.stringify(fields));
}

function parseInclude(value) {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  const names = [...new Set(list.map((s) => String(s).trim()).filter(Boolean))];
  return names.every((n) => RELATED_RESOURCES.includes(n)) ? names : null;
}

export async function handler(event = {}, context = {}) {
  const requestId = context.awsRequestId;
  const isUrlInvoke = Boolean(event.requestContext?.http);

  if (isUrlInvoke && event.requestContext.http.method !== 'GET') {
    return respond(405, { error: 'Method not allowed' });
  }

  const params = isUrlInvoke ? event.queryStringParameters ?? {} : event;
  const serial = params.serial;
  if (typeof serial !== 'string' || !SERIAL_PATTERN.test(serial)) {
    return respond(400, { error: 'serial must be 8-14 uppercase alphanumeric characters' });
  }

  const include = parseInclude(params.include);
  if (!include) {
    return respond(400, { error: `include may only contain: ${RELATED_RESOURCES.join(', ')}` });
  }

  try {
    const result = await lookupDevice(serial, include);
    log({ requestId, serial, upstreamStatus: result.status });
    if (result.status === 404) return respond(404, { error: 'Device not found' });
    return respond(200, result.body);
  } catch (err) {
    // Deliberately log no error message or stack: only id, serial and status.
    log({ requestId, serial, upstreamStatus: err instanceof UpstreamError ? err.status ?? null : null });
    return respond(502, { error: 'Upstream request failed' });
  }
}
