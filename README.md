# ab-lambda

A small AWS Lambda function that looks up a device in **Apple Business** (formerly Apple Business Manager) by serial number, using the [Apple Business API](https://developer.apple.com/documentation/applebusinessapi). It also works with Apple School Manager by changing two parameters.

Its purpose is to back a **[Nexthink API call](https://docs.nexthink.com/configuring_nexthink/bringing-data-into-your-nexthink-instance/integrating-nexthink-with-third-party-tools/api-calls) triggered from Nexthink Workspaces**, so support staff can see a device's Apple Business record while working on it. See [Using it from Nexthink Workspaces](#using-it-from-nexthink-workspaces).

- Node.js 22.x, ES modules, **no runtime npm dependencies** (built-in `crypto` and `fetch`; the AWS SDK v3 that ships with the Lambda runtime).
- Exposed through a **Lambda Function URL protected by a bearer token**: every request must send `Authorization: Bearer <token>`, or it is rejected with 401 before anything else happens.
- The Apple private key and the bearer token live **only in AWS Secrets Manager**.
- Deploy with **AWS SAM** (this page) or **Terraform**: see [terraform/README.md](terraform/README.md) for a step-by-step guide, including how to keep the Apple key and the token safe.

## What it does

```
GET <function-url>/?serial=C02XXXXXXXXX
GET <function-url>/?serial=C02XXXXXXXXX&include=assignedServer,appleCareCoverage
Authorization: Bearer <token>
```

or a direct invoke with `{"serial": "C02XXXXXXXXX", "include": ["assignedServer"]}` (direct invokes need the IAM permission `lambda:InvokeFunction` instead of the token).

| Result | Status | Body |
| --- | --- | --- |
| Device found | 200 | Apple's JSON from `GET /v1/orgDevices/{serial}`, plus `assignedServer` / `appleCareCoverage` keys when requested (a related resource Apple reports as 404 is `null`) |
| Missing or wrong bearer token | 401 | `{"error":"Unauthorized"}` (nothing else is checked or called) |
| Device not in your organization | 404 | `{"error":"Device not found"}` |
| Serial not 8–14 uppercase alphanumeric, or unknown `include` value | 400 | error message (no call to Apple is made) |
| Non-GET Function URL request | 405 | error message |
| Secrets Manager, token or Apple API failure | 502 | `{"error":"Upstream request failed"}` |

Each request writes one log line containing only the request id, the serial, and the upstream HTTP status (or `"auth": "rejected"` for a refused token).

## Architecture

```
caller ──HTTPS + Bearer token──▶ Function URL ──▶ Lambda
                                                   │ 0. check the bearer token (token secret re-read every 5 min)
                                                   │ 1. GetSecretValue for the Apple key (cached per container)
                                                   ├──────────────▶ Secrets Manager
                                                   │ 2. ES256 client-assertion JWT, POST /auth/oauth2/token
                                                   ├──────────────▶ account.apple.com   (token cached until ~60 s before expiry)
                                                   │ 3. GET /v1/orgDevices/{serial}[/assignedServer|/appleCareCoverage]
                                                   └──────────────▶ api-business.apple.com
```

| File | Purpose |
| --- | --- |
| `src/index.mjs` | Handler: bearer token check, input validation, response mapping, logging |
| `src/abm.mjs` | Client assertion JWT, OAuth token (with cache), API calls, 401 retry |
| `src/secret.mjs` | Secrets Manager access (with caches) |
| `template.yaml` | AWS SAM template |
| `terraform/` | Terraform module, example and step-by-step guide |
| `test/` | `node:test` suite with mocked `fetch` and a throwaway EC key generated at test time |

On a `401` from Apple's API the cached Apple token is dropped and the call retried once.

## Prerequisites

- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
- AWS CLI v2 with credentials for the target account, plus `jq` and `openssl`
- Node.js 22+ (for running tests locally)
- Administrator access to Apple Business (Organization Administrator role)

## 1. Create the Apple API account and key

1. Sign in to [Apple Business](https://business.apple.com) as an Organization Administrator.
2. Go to **Settings > API** and create an API account. Download the private key (`.pem`) when it is offered, to a local folder that isn't synced to the cloud.
3. Note the **Client ID** (looks like `BUSINESSAPI.00000000-0000-0000-0000-000000000000`) and the **Key ID**. They are different values; putting the Client ID in the Key ID field makes Apple reject every token request with 400.

For Apple School Manager the client ID starts with `SCHOOLAPI.`; use scope `school.api` and API base URL `https://api-school.apple.com` when deploying.

## 2. Store the Apple credentials in Secrets Manager

This reads the `.pem` file and pipes it straight into Secrets Manager, so no intermediate file is written and the key never appears on screen. Every value is a placeholder:

```bash
jq -n --arg client_id "BUSINESSAPI.00000000-0000-0000-0000-000000000000" --arg key_id "00000000-0000-0000-0000-000000000000" --rawfile private_key_pem ./your-downloaded-key.pem '{client_id:$client_id, key_id:$key_id, private_key_pem:$private_key_pem}' | aws secretsmanager create-secret --name abm/api-credentials --description "Apple Business API credentials" --secret-string file:///dev/stdin --query ARN --output text
```

Then delete the downloaded key:

```bash
rm ./your-downloaded-key.pem
```

The secret must contain exactly these keys: `client_id`, `key_id`, `private_key_pem` (the EC P-256 PEM from Apple).

## 3. Create the bearer token secret

The bearer token is what Nexthink sends to prove it may call the function. This generates a random 256-bit token, stores it in Secrets Manager, and copies it to your clipboard (macOS `pbcopy`; on Linux use `xclip -selection clipboard` or `wl-copy`) without printing it:

```bash
( TOKEN="$(openssl rand -hex 32)" && jq -n --arg token "$TOKEN" '{token:$token}' | aws secretsmanager create-secret --name abm/nexthink-bearer-token --description "Bearer token Nexthink uses to call the device lookup function" --secret-string file:///dev/stdin --query ARN --output text && printf %s "$TOKEN" | pbcopy && echo "Token copied to the clipboard" )
```

Paste it into Nexthink in [step 2 of the Nexthink setup](#2-create-the-nexthink-third-party-credentials-bearer-token), then clear your clipboard by copying something else. To copy it again later:

```bash
aws secretsmanager get-secret-value --secret-id abm/nexthink-bearer-token --query SecretString --output text | jq -r .token | pbcopy
```

**The token doesn't expire and doesn't refresh itself.** It stays valid until you replace it, and it can't rotate automatically, because the new value must also be pasted into Nexthink. Rotate it every 90 days; see [Security](#security).

The secret is JSON: `{"token": "..."}`, optionally with `"previous_token"` during rotation. Tokens shorter than 32 characters are refused, and the function then fails closed with 502.

## 4. Build and deploy

Using Terraform instead? Follow [terraform/README.md](terraform/README.md) from here.

```bash
sam build
```

```bash
sam deploy --guided
```

When prompted:

| Parameter | Value |
| --- | --- |
| `SecretId` | The Apple secret **name**, for example `abm/api-credentials` (not the ARN) |
| `AuthMode` | `BearerToken` (default) |
| `AuthTokenSecretId` | The token secret name, for example `abm/nexthink-bearer-token` |
| `AbmScope`, `AbmApiBaseUrl` | Defaults for Apple Business |

The stack output `FunctionUrl` is the endpoint. `sam deploy --guided` writes `samconfig.toml`, which contains your stack settings; it is git-ignored and should never be committed.

## 5. Call the Function URL

The token is read from Secrets Manager inline, so it isn't stored in your shell history:

```bash
curl -s -H "Authorization: Bearer $(aws secretsmanager get-secret-value --secret-id abm/nexthink-bearer-token --query SecretString --output text | jq -r .token)" "https://<url-id>.lambda-url.<region>.on.aws/?serial=C02XXXXXXXXX&include=assignedServer,appleCareCoverage" | jq
```

Without the header you should get `401`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' "https://<url-id>.lambda-url.<region>.on.aws/?serial=C02XXXXXXXXX"
```

Direct invoke (uses your AWS credentials, no token):

```bash
aws lambda invoke --function-name <function-name> --cli-binary-format raw-in-base64-out --payload '{"serial":"C02XXXXXXXXX"}' out.json
```

## Using it from Nexthink Workspaces

Nexthink reference: [API calls](https://docs.nexthink.com/configuring_nexthink/bringing-data-into-your-nexthink-instance/integrating-nexthink-with-third-party-tools/api-calls) and [Third-party credentials](https://docs.nexthink.com/configuring_nexthink/bringing-data-into-your-nexthink-instance/integrating-nexthink-with-third-party-tools/outbound-connectors/connector-credentials).

### Why a function sits in between

Nexthink API calls authenticate with Basic, Bearer token or OAuth 2.0 credentials that use a **client secret**. Apple's API has no client secret: every token request must carry a JWT signed with your private key (ES256). Nexthink can't produce that signature, so this function does it. Nexthink calls the function with a bearer token, and the Apple key stays in AWS Secrets Manager.

```
Workspaces ──▶ Nexthink API call (GET) ──Bearer token──▶ Function URL ──▶ Lambda ──▶ Apple Business API
                 credentials: Bearer token                                   │
                                                                             └─▶ Secrets Manager (Apple key, token)
```

### 1. Deploy the function

Complete steps 1–4 above (or the Terraform guide). Note the Function URL, and keep the token from step 3 ready to paste.

### 2. Create the Nexthink Third-party credentials (Bearer token)

Nexthink reaches the function through **Third-party credentials**, which the **Nexthink admin** sets up following Nexthink's [Third-party credentials documentation](https://docs.nexthink.com/configuring_nexthink/bringing-data-into-your-nexthink-instance/integrating-nexthink-with-third-party-tools/outbound-connectors/connector-credentials). The **AWS admin** provides the token. Neither admin ever handles the Apple private key.

| Field | Value |
| --- | --- |
| Name | For example `ABM device lookup` |
| Protocol | **HTTPS** |
| URL | `https://<url-id>.lambda-url.<region>.on.aws` (your Function URL) |
| Authorization type | **Bearer token** |
| Header prefix | `Bearer` |
| Token | The token from step 3 |

Handing the token over:

- Ideally the person who creates the token secret pastes it into Nexthink directly from the clipboard.
- Otherwise, share it through your organization's password manager. Never by email, chat, tickets or documents.
- The token can only call this read-only lookup, but anyone who has it can query your devices, so treat it like a password.

> Nexthink's credentials form also offers an **AWS IAM** protocol. It isn't fully functional for API calls yet, so it isn't used here. The function can switch to AWS SigV4 signing (`AuthMode=AwsIam`) once it is.

### 3. Create the API call

In Nexthink's API calls configuration, create a call from scratch:

**General tab**

| Field | Value |
| --- | --- |
| Name | For example `Apple Business device lookup` |
| Credentials | The Bearer token credentials from step 2 |
| URL | Filled in from the credentials |
| Trigger | **Workspaces** |

Triggering API calls from Workspaces isn't described in Nexthink's API calls documentation yet. Confirm the exact **Trigger** option in your instance.

**Request tab**

| Field | Value |
| --- | --- |
| Parameters | `serial`: the device's serial number, supplied by Workspaces |
| Request method | `GET` (the only method the function accepts) |
| Resource | `/?serial={{serial}}&include=assignedServer,appleCareCoverage` |
| Payload | None |

Check that Nexthink joins **URL** and **Resource** into `https://<url-id>.lambda-url.<region>.on.aws/?serial=…`. Drop `&include=…` if you only need the device record; each related resource is an extra request to Apple.

The function accepts only **8–14 uppercase letters and digits**. Pass the serial exactly as the device reports it; anything else returns 400 without calling Apple.

**Output tab** (JSONata, evaluated against the function's JSON response)

| Output | Value (JSONata) |
| --- | --- |
| Product family | `data.attributes.productFamily` |
| Model | `data.attributes.deviceModel` |
| Assignment status | `data.attributes.status` |
| Added to organization | `data.attributes.addedToOrgDateTime` |
| Released from organization | `data.attributes.releasedFromOrgDateTime` |
| Device management service | `assignedServer.data.attributes.serverName` |
| AppleCare status | `appleCareCoverage.data[0].attributes.status` |
| AppleCare end date | `appleCareCoverage.data[0].attributes.endDateTime` |

`assignedServer` is `null` when no device management service is assigned, and `appleCareCoverage.data` is an empty list when there is no coverage. The expressions above then return nothing rather than failing.

### 4. Test and share

1. Use the API call's **Test results** panel with a known serial. This makes a real call to the function, and through it to Apple. Expect status 200.
2. Grant the **Execute** permission only to the Nexthink roles that should run the lookup from Workspaces.

| Test status | Meaning |
| --- | --- |
| 200 | Working |
| 401 | The token is missing or wrong: check the credentials' **Authorization type**, **Header prefix** (`Bearer`) and **Token** |
| 404 | The serial isn't in your Apple Business organization |
| 400 | The serial isn't 8–14 uppercase letters and digits |
| 502 | The function couldn't read a secret or reach Apple. Check its CloudWatch log line |

## Configuration

| Env var | Template parameter | Default |
| --- | --- | --- |
| `ABM_SECRET_ID` | `SecretId` | (required) |
| `ABM_SCOPE` | `AbmScope` | `business.api` |
| `ABM_API_BASE_URL` | `AbmApiBaseUrl` | `https://api-business.apple.com` |
| `AUTH_TOKEN_SECRET_ID` | `AuthTokenSecretId` | (required in `BearerToken` mode) |
| — | `AuthMode` | `BearerToken`; `AwsIam` requires SigV4-signed requests instead and turns the token check off |

The SAM template refuses to deploy `BearerToken` mode without `AuthTokenSecretId`, so the Function URL is never reachable without a token check.

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

CI (`.github/workflows/ci.yml`) runs lint, tests, Terraform checks, and a [gitleaks](https://github.com/gitleaks/gitleaks) scan of the full git history. To run gitleaks before every commit, install the optional hook in `.pre-commit-config.yaml` with `pre-commit install`.

## Security

- **The Apple private key and the bearer token live only in AWS Secrets Manager.** Neither is ever in code, config, environment variables, tests, Terraform state or git history. Tests generate a throwaway EC key and dummy tokens at run time.
- **Least-privilege IAM:** the function may only call `secretsmanager:GetSecretValue` on its two secrets; their ARNs are built from the deploying account's partition, region and account ID, so none are hard-coded. If the secrets use a customer-managed KMS key, also grant `kms:Decrypt` on that key.
- **The token check runs first.** The Function URL is reachable on the internet, but any request without a valid token gets 401 before input is validated, the Apple key is read or Apple is called. Tokens are compared in constant time and are never logged or returned.
- **Cap abuse:** rejected requests still start the function briefly. To limit cost and protect your Apple API rate limit, reserve a small concurrency (`aws lambda put-function-concurrency --function-name <function-name> --reserved-concurrent-executions 5`; not possible on accounts with a low concurrency quota), and alarm on log lines containing `"auth":"rejected"`.
- **Nothing sensitive leaves the function:** Apple access tokens, the client assertion and secret material are never logged or returned. Upstream errors are returned as a generic 502.
- **Rotate the bearer token every 90 days**, whenever someone who had access to it leaves, and right away if it may have leaked. Unlike Apple's access tokens (1 hour), which the function renews by itself, the bearer token never expires on its own, so rotation is a manual task: put it on your team's calendar. To see when it was last changed:

  ```bash
  aws secretsmanager describe-secret --secret-id abm/nexthink-bearer-token --query '{Created:CreatedDate,LastChanged:LastChangedDate}'
  ```

  Rotation causes no downtime:
  1. Store a new token and keep the old one as `previous_token` (the new token is copied to your clipboard):

     ```bash
     ( NEW="$(openssl rand -hex 32)" && aws secretsmanager get-secret-value --secret-id abm/nexthink-bearer-token --query SecretString --output text | jq --arg t "$NEW" '{token:$t, previous_token:.token}' | aws secretsmanager put-secret-value --secret-id abm/nexthink-bearer-token --secret-string file:///dev/stdin --query VersionId --output text && printf %s "$NEW" | pbcopy && echo "New token copied to the clipboard" )
     ```

  2. Wait 5 minutes; the function re-reads the token secret at least that often.
  3. Paste the new token into the Nexthink credentials and test the API call.
  4. Remove the old token:

     ```bash
     aws secretsmanager get-secret-value --secret-id abm/nexthink-bearer-token --query SecretString --output text | jq '{token}' | aws secretsmanager put-secret-value --secret-id abm/nexthink-bearer-token --secret-string file:///dev/stdin --query VersionId --output text
     ```

  For a suspected leak, skip keeping `previous_token`: store only the new token, then update Nexthink.
- **Rotate the Apple key** by creating a new key in Apple Business (Settings > API), updating the Apple secret with `put-secret-value` (same pipe as step 2), and revoking the old key in Apple Business. Running containers keep the Apple key until their next cold start; to force it immediately, update the function configuration or redeploy.
- **Never commit `samconfig.toml`**, `.pem`/`.key` files, `.env*` files, or secret JSON. All are in `.gitignore`, and gitleaks runs in CI.

## Apple documentation

Endpoint paths and token parameters were checked against:

- Apple School Manager and Apple Business APIs: <https://developer.apple.com/documentation/apple-school-and-business-manager-api>
- Implementing OAuth: <https://developer.apple.com/documentation/apple-school-and-business-manager-api/implementing-oauth-for-the-apple-school-manager-and-apple-business-api>
- Apple Business API: <https://developer.apple.com/documentation/applebusinessapi>
- Get Device Information (`GET /v1/orgDevices/{id}`): <https://developer.apple.com/documentation/applebusinessapi/get-orgdevice-information>
- Get the Assigned Device Management Service Information (`GET /v1/orgDevices/{id}/assignedServer`): <https://developer.apple.com/documentation/applebusinessapi/get-the-assigned-server-information-for-an-orgdevice>
- Get AppleCare Coverage (`GET /v1/orgDevices/{id}/appleCareCoverage`): <https://developer.apple.com/documentation/applebusinessapi/get-all-applecare-coverage-for-an-orgdevice>

Token request: `POST https://account.apple.com/auth/oauth2/token` (form-encoded `grant_type=client_credentials`, `client_id`, `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`, `client_assertion`, `scope`). The client assertion's `aud` is `https://account.apple.com/auth/oauth2/v2/token`. Tokens last one hour.
