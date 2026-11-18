// Loads secrets from AWS Secrets Manager:
// - the Apple Business API credentials, cached for the container lifetime;
// - the optional caller bearer token(s), re-read every few minutes so a
//   rotated token takes effect without a redeploy.

const REQUIRED_KEYS = ['client_id', 'key_id', 'private_key_pem'];
const MIN_TOKEN_LENGTH = 32;
const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;

let cachedAbm;
let cachedTokens; // { tokens, expiresAt }
let loader = defaultLoader;

async function defaultLoader(secretId) {
  // The AWS SDK v3 ships with the Lambda Node.js runtime, so it is imported
  // lazily here rather than bundled.
  const { SecretsManagerClient, GetSecretValueCommand } = await import(
    '@aws-sdk/client-secrets-manager'
  );
  const client = new SecretsManagerClient({});
  const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  return res.SecretString;
}

async function loadJson(secretId) {
  const raw = await loader(secretId);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Secret is not valid JSON');
  }
}

export async function getAbmSecret() {
  if (cachedAbm) return cachedAbm;

  const secretId = process.env.ABM_SECRET_ID;
  if (!secretId) throw new Error('ABM_SECRET_ID is not set');

  const parsed = await loadJson(secretId);
  for (const key of REQUIRED_KEYS) {
    if (typeof parsed?.[key] !== 'string' || parsed[key] === '') {
      throw new Error(`Secret is missing required key: ${key}`);
    }
  }

  cachedAbm = {
    clientId: parsed.client_id,
    keyId: parsed.key_id,
    privateKeyPem: parsed.private_key_pem,
  };
  return cachedAbm;
}

// Returns the accepted bearer tokens, or null when AUTH_TOKEN_SECRET_ID is not
// set (token checking disabled). The secret is JSON: {"token": "...",
// "previous_token": "..."}; previous_token is optional and eases rotation.
export async function getAuthTokens() {
  const secretId = process.env.AUTH_TOKEN_SECRET_ID;
  if (!secretId) return null;
  if (cachedTokens && Date.now() < cachedTokens.expiresAt) return cachedTokens.tokens;

  const parsed = await loadJson(secretId);
  const tokens = [parsed?.token, parsed?.previous_token].filter((t) => t !== undefined && t !== null && t !== '');
  if (typeof parsed?.token !== 'string' || !tokens.every((t) => typeof t === 'string' && t.length >= MIN_TOKEN_LENGTH)) {
    throw new Error(`Token secret must hold "token" (and optionally "previous_token") of at least ${MIN_TOKEN_LENGTH} characters`);
  }

  cachedTokens = { tokens, expiresAt: Date.now() + TOKEN_CACHE_TTL_MS };
  return tokens;
}

// Test hooks.
export function _setSecretLoader(fn) {
  loader = fn ?? defaultLoader;
  _resetSecretCache();
}

export function _resetSecretCache() {
  cachedAbm = undefined;
  cachedTokens = undefined;
}
