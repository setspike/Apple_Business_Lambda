# ab-lambda

A small AWS Lambda function that looks up a device in **Apple Business** (formerly Apple Business Manager) by serial number, using the [Apple Business API](https://developer.apple.com/documentation/applebusinessapi). It also works with Apple School Manager by changing two parameters.

Its purpose is to back a **[Nexthink API call](https://docs.nexthink.com/configuring_nexthink/bringing-data-into-your-nexthink-instance/integrating-nexthink-with-third-party-tools/api-calls) triggered from Nexthink Workspaces**, so support staff can see a device's Apple Business record while working on it. See [Using it from Nexthink Workspaces](#using-it-from-nexthink-workspaces).

- Node.js 22.x, ES modules, **no runtime npm dependencies** (built-in `crypto` and `fetch`; the AWS SDK v3 that ships with the Lambda runtime).
- Exposed through a **Lambda Function URL with `AWS_IAM` auth**, so every caller must sign requests with SigV4.
- The Apple private key lives **only in AWS Secrets Manager**.
- Deploy with **AWS SAM** (this page) or **Terraform**: see [terraform/README.md](terraform/README.md) for a step-by-step guide, including how to keep the Apple key safe.

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

Using Terraform instead? Follow [terraform/README.md](terraform/README.md) from here.

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

## Using it from Nexthink Workspaces

Nexthink reference: [API calls](https://docs.nexthink.com/configuring_nexthink/bringing-data-into-your-nexthink-instance/integrating-nexthink-with-third-party-tools/api-calls) and [Third-party credentials](https://docs.nexthink.com/configuring_nexthink/bringing-data-into-your-nexthink-instance/integrating-nexthink-with-third-party-tools/outbound-connectors/connector-credentials).

### Why a function sits in between

Nexthink API calls authenticate with Basic, Bearer token or OAuth 2.0 credentials that use a **client secret**. Apple's API has no client secret: every token request must carry a JWT signed with your private key (ES256). Nexthink can't produce that signature, so this function does it. Nexthink calls the function, and the Apple key stays in AWS Secrets Manager.

```
Workspaces ──▶ Nexthink API call (GET) ──SigV4──▶ Function URL (AWS_IAM) ──▶ Lambda ──▶ Apple Business API
                 credentials: AWS IAM role                                      │
                                                                                └─▶ Secrets Manager (Apple key)
```

### 1. Deploy the function

Deploy with SAM (above) or Terraform ([terraform/README.md](terraform/README.md)), keeping the Function URL on `AWS_IAM`. Note the Function URL and the function ARN.

### 2. Create the Nexthink Third-party credentials (AWS IAM)

Nexthink reaches the function through **Third-party credentials**, which the **Nexthink admin** sets up following Nexthink's [Third-party credentials documentation](https://docs.nexthink.com/configuring_nexthink/bringing-data-into-your-nexthink-instance/integrating-nexthink-with-third-party-tools/outbound-connectors/connector-credentials). The credentials point at an IAM role that the **AWS admin** creates. Neither admin ever handles the Apple private key.

1. **Nexthink admin:** create Third-party credentials, give them a name, and choose **AWS IAM** as the **Protocol**.
2. **Nexthink admin:** copy the **AWS External ID** that Nexthink generates and send it to the AWS admin. It isn't a password, but share it only with them.
3. **AWS admin:** create a role that Nexthink can assume. Per Nexthink's AWS documentation, its name must start with `NexthinkConnector-`, and its trust policy names Nexthink's AWS account `884848470805` and requires your External ID. Save this as `nexthink-trust.json` (git-ignored):

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Principal": { "AWS": "arn:aws:iam::884848470805:root" },
       "Action": "sts:AssumeRole",
       "Condition": { "StringEquals": { "sts:ExternalId": "<external-id-from-nexthink>" } }
     }]
   }
   ```

   ```bash
   aws iam create-role --role-name NexthinkConnector-AbmLookup --assume-role-policy-document file://nexthink-trust.json --query Role.Arn --output text
   ```

4. **AWS admin:** allow that role to call **only** this function. With Terraform, use `terraform output -raw invoke_policy_json`. Otherwise:

   ```bash
   aws iam put-role-policy --role-name NexthinkConnector-AbmLookup --policy-name InvokeAbmLookup --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["lambda:InvokeFunctionUrl","lambda:InvokeFunction"],"Resource":"<function-arn>"}]}'
   ```

5. **AWS admin:** send the role ARN to the Nexthink admin. **Nexthink admin:** paste it into **AWS Role ARN** and save the credentials.

> **Confirm with Nexthink:** the AWS IAM protocol appears in the credentials form, but Nexthink's credentials documentation doesn't yet cover it, and its AWS documentation describes it only for the AWS AppStream connector. The function needs requests signed with SigV4 for service `lambda` in your function's region. If Nexthink's API calls don't sign that way, the test in step 4 returns 403. Ask Nexthink Support to confirm, and see [If AWS IAM credentials don't work](#if-aws-iam-credentials-dont-work).

### 3. Create the API call

In Nexthink's API calls configuration, create a call from scratch:

**General tab**

| Field | Value |
| --- | --- |
| Name | For example `Apple Business device lookup` |
| Credentials | The AWS IAM credential from step 2 |
| URL | `https://<url-id>.lambda-url.<region>.on.aws` (your Function URL) |
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
| 404 | The serial isn't in your Apple Business organization |
| 400 | The serial isn't 8–14 uppercase letters and digits |
| 403 | AWS refused the request: the role lacks invoke permission, or Nexthink isn't signing with SigV4 for `lambda` |
| 502 | The function couldn't reach Apple. Check its CloudWatch log line's `upstreamStatus` |

### If AWS IAM credentials don't work

Don't switch the Function URL to `NONE` for production; that makes your device data public. Nexthink's documented **OAuth 2.0 - Client credentials** type is a supported alternative: put an Amazon API Gateway HTTP API with a JWT authorizer in front of the function, and have an Amazon Cognito app client issue tokens with a client ID and secret that you store in Nexthink. That piece isn't part of this repo yet.

## Configuration

| Env var | Template parameter | Default |
| --- | --- | --- |
| `ABM_SECRET_ID` | `SecretId` | (required) |
| `ABM_SCOPE` | `AbmScope` | `business.api` |
| `ABM_API_BASE_URL` | `AbmApiBaseUrl` | `https://api-business.apple.com` |
| — | `FunctionUrlAuthType` | `AWS_IAM` (`NONE` makes the URL public; testing only) |

### Temporarily allowing unsigned requests (test stacks only)

`FunctionUrlAuthType=NONE` makes the Function URL public: **anyone who has the URL can look up devices in your organization**. Use it only on a short-lived test stack, and switch back when you are done:

```bash
sam deploy --parameter-overrides SecretId=abm/api-credentials FunctionUrlAuthType=NONE
```

```bash
curl -s "https://<url-id>.lambda-url.<region>.on.aws/?serial=C02XXXXXXXXX" | jq
```

```bash
sam deploy --parameter-overrides SecretId=abm/api-credentials FunctionUrlAuthType=AWS_IAM
```

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
- **Authenticated endpoint:** the Function URL uses `AWS_IAM` auth by default; grant `lambda:InvokeFunctionUrl` only to the principals that need it. Never deploy with `FunctionUrlAuthType=NONE` against production data.
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
