# ab-lambda

A small AWS Lambda function that looks up a device in **Apple Business** (formerly Apple Business Manager) by serial number, using the [Apple Business API](https://developer.apple.com/documentation/applebusinessapi). It also works with Apple School Manager by changing two parameters.

- Node.js 22.x, ES modules, **no runtime npm dependencies** (built-in `crypto` and `fetch`; the AWS SDK v3 that ships with the Lambda runtime).
- Exposed through a **Lambda Function URL with `AWS_IAM` auth**, so every caller must sign requests with SigV4.
- The Apple private key lives **only in AWS Secrets Manager**.

## What it does

```
GET <function-url>/?serial=C02XXXXXXXXX
GET <function-url>/?serial=C02XXXXXXXXX&include=assignedServer,appleCareCoverage
```

or a direct invoke with `{"serial": "C02XXXXXXXXX", "include": ["assignedServer"]}`.

| Result | Status | Body |
| --- | --- | --- |
| Device found | 200 | Apple's JSON from `GET /v1/orgDevices/{serial}`, plus `assignedServer` / `appleCareCoverage` keys when requested (a related resource Apple reports as 404 is `null`) |
| Device not in your organization | 404 | `{"error":"Device not found"}` |
| Serial not 8–14 uppercase alphanumeric, or unknown `include` value | 400 | error message (no network call is made) |
| Non-GET Function URL request | 405 | error message |
| Secrets Manager, token or Apple API failure | 502 | `{"error":"Upstream request failed"}` |

Each request writes one log line containing only the request id, the serial, and the upstream HTTP status.

## Architecture

```
caller ──SigV4──▶ Function URL (AWS_IAM) ──▶ Lambda
                                               │ 1. GetSecretValue (cached per container)
                                               ├──────────────▶ Secrets Manager
                                               │ 2. ES256 client-assertion JWT, POST /auth/oauth2/token
                                               ├──────────────▶ account.apple.com   (token cached until ~60 s before expiry)
                                               │ 3. GET /v1/orgDevices/{serial}[/assignedServer|/appleCareCoverage]
                                               └──────────────▶ api-business.apple.com
```

| File | Purpose |
| --- | --- |
| `src/index.mjs` | Handler: input validation, response mapping, logging |
| `src/abm.mjs` | Client assertion JWT, OAuth token (with cache), API calls, 401 retry |
| `src/secret.mjs` | Secrets Manager access (with cache) |
| `template.yaml` | AWS SAM template |
| `test/` | `node:test` suite with mocked `fetch` and a throwaway EC key generated at test time |

On a `401` from the API the cached token is dropped and the call retried once.

## Prerequisites

- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
- AWS CLI with credentials for the target account
- Node.js 22+ (for running tests locally)
- Administrator access to Apple Business (Organization Administrator role)

## 1. Create the Apple API account and key

1. Sign in to [Apple Business](https://business.apple.com) as an Organization Administrator.
2. Go to **Settings > API** and create an API account. Apple generates a private key; download the `.pem` file immediately and store it somewhere safe outside this repository.
3. Note the **Client ID** (looks like `BUSINESSAPI.00000000-0000-0000-0000-000000000000`) and the **Key ID** shown for the account.

For Apple School Manager the client ID starts with `SCHOOLAPI.`; use scope `school.api` and API base URL `https://api-school.apple.com` when deploying.

## 2. Store the credentials in Secrets Manager

Build the secret JSON from the downloaded key in a working directory **outside this repo** (or rely on `.gitignore`, which already excludes `*.pem` and `abm-secret.json`). Every value below is a placeholder:

```bash
jq -n \
  --arg client_id "BUSINESSAPI.00000000-0000-0000-0000-000000000000" \
  --arg key_id    "00000000-0000-0000-0000-000000000000" \
  --rawfile private_key_pem ./your-downloaded-key.pem \
  '{client_id: $client_id, key_id: $key_id, private_key_pem: $private_key_pem}' > abm-secret.json
```

```bash
aws secretsmanager create-secret \
  --name abm/api-credentials \
  --description "Apple Business API credentials" \
  --secret-string file://abm-secret.json
```

Then delete the local files:

```bash
rm abm-secret.json ./your-downloaded-key.pem
```

The secret must contain exactly these keys: `client_id`, `key_id`, `private_key_pem` (the EC P-256 PEM from Apple).

## 3. Build and deploy

```bash
sam build
```

```bash
sam deploy --guided
```

When prompted, set `SecretId` to the secret **name** (for example `abm/api-credentials`, not the ARN). Leave `AbmScope` and `AbmApiBaseUrl` at their defaults for Apple Business. The stack output `FunctionUrl` is the endpoint.

`sam deploy --guided` writes `samconfig.toml`, which contains your stack settings; it is git-ignored and should never be committed.

## 4. Call the Function URL

Requests must be SigV4-signed for service `lambda`. The caller needs `lambda:InvokeFunctionUrl` on the function. With [awscurl](https://github.com/okigan/awscurl):

```bash
awscurl --service lambda --region <region> \
  "https://<url-id>.lambda-url.<region>.on.aws/?serial=C02XXXXXXXXX&include=assignedServer,appleCareCoverage"
```

Direct invoke:

```bash
aws lambda invoke --function-name <function-name> \
  --cli-binary-format raw-in-base64-out \
  --payload '{"serial":"C02XXXXXXXXX"}' out.json
```

## Configuration

| Env var | Template parameter | Default |
| --- | --- | --- |
| `ABM_SECRET_ID` | `SecretId` | (required) |
| `ABM_SCOPE` | `AbmScope` | `business.api` |
| `ABM_API_BASE_URL` | `AbmApiBaseUrl` | `https://api-business.apple.com` |

## Development

```bash
npm install
```

```bash
npm test
```

```bash
npm run lint
```

CI (`.github/workflows/ci.yml`) runs lint, tests, and a [gitleaks](https://github.com/gitleaks/gitleaks) scan of the full git history. To run gitleaks before every commit, install the optional hook in `.pre-commit-config.yaml` with `pre-commit install`.

## Security

- **The private key lives only in AWS Secrets Manager.** It is never in code, config, environment variables, tests, or git history. Tests generate a throwaway EC key in memory at run time.
- **Least-privilege IAM:** the function may only call `secretsmanager:GetSecretValue` on the one secret named by `SecretId`; the ARN is built from the deploying account's partition, region and account ID, so none are hard-coded. If the secret uses a customer-managed KMS key, also grant `kms:Decrypt` on that key.
- **Authenticated endpoint:** the Function URL uses `AWS_IAM` auth; grant `lambda:InvokeFunctionUrl` only to the principals that need it.
- **Nothing sensitive leaves the function:** access tokens, the client assertion and secret material are never logged or returned. Upstream errors are returned as a generic 502.
- **Rotate the key** by creating a new key in Apple Business (Settings > API), updating the secret (`aws secretsmanager put-secret-value --secret-id abm/api-credentials --secret-string file://abm-secret.json`), and revoking the old key in Apple Business. Running containers pick up the new secret on their next cold start; to force it immediately, update the function configuration or redeploy.
- **Never commit `samconfig.toml`**, `.pem`/`.key` files, `.env*` files, or the secret JSON. All are in `.gitignore`, and gitleaks runs in CI.

## Apple documentation

Endpoint paths and token parameters were checked against:

- Apple School Manager and Apple Business APIs: <https://developer.apple.com/documentation/apple-school-and-business-manager-api>
- Implementing OAuth: <https://developer.apple.com/documentation/apple-school-and-business-manager-api/implementing-oauth-for-the-apple-school-manager-and-apple-business-api>
- Apple Business API: <https://developer.apple.com/documentation/applebusinessapi>
- Get Device Information (`GET /v1/orgDevices/{id}`): <https://developer.apple.com/documentation/applebusinessapi/get-orgdevice-information>
- Get the Assigned Device Management Service Information (`GET /v1/orgDevices/{id}/assignedServer`): <https://developer.apple.com/documentation/applebusinessapi/get-the-assigned-server-information-for-an-orgdevice>
- Get AppleCare Coverage (`GET /v1/orgDevices/{id}/appleCareCoverage`): <https://developer.apple.com/documentation/applebusinessapi/get-all-applecare-coverage-for-an-orgdevice>

Token request: `POST https://account.apple.com/auth/oauth2/token` (form-encoded `grant_type=client_credentials`, `client_id`, `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`, `client_assertion`, `scope`). The client assertion's `aud` is `https://account.apple.com/auth/oauth2/v2/token`. Tokens last one hour.
