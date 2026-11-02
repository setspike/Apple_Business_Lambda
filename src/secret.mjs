// Loads the Apple Business API credentials from AWS Secrets Manager.
// The secret is cached for the lifetime of the Lambda container.

const REQUIRED_KEYS = ['client_id', 'key_id', 'private_key_pem'];

let cached;
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

export async function getAbmSecret() {
  if (cached) return cached;

  const secretId = process.env.ABM_SECRET_ID;
  if (!secretId) throw new Error('ABM_SECRET_ID is not set');

  const raw = await loader(secretId);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Secret is not valid JSON');
  }
  for (const key of REQUIRED_KEYS) {
    if (typeof parsed?.[key] !== 'string' || parsed[key] === '') {
      throw new Error(`Secret is missing required key: ${key}`);
    }
  }

  cached = {
    clientId: parsed.client_id,
    keyId: parsed.key_id,
    privateKeyPem: parsed.private_key_pem,
  };
  return cached;
}

// Test hooks.
export function _setSecretLoader(fn) {
  loader = fn ?? defaultLoader;
  cached = undefined;
}

export function _resetSecretCache() {
  cached = undefined;
}
