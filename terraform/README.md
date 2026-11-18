# Deploying with Terraform

This module deploys the Apple Business device lookup function into **your own AWS account**. It creates:

- the Lambda function (Node.js 22, arm64), built straight from `src/` with no build step
- an execution role that can **only** write its own logs and read **its two secrets** (the Apple credentials and the bearer token)
- a Function URL protected by a **bearer token**: every request must send `Authorization: Bearer <token>`, and anything else gets 401 before the function does any work. This is what Nexthink uses.
- a CloudWatch log group with a retention period
- optional permissions for other AWS accounts or roles to invoke the function directly

It does **not** create or read either secret's value. You put the Apple credentials and the token into Secrets Manager yourself (steps 3 and 4), so neither passes through Terraform or its state file.

The module also supports `auth_mode = "aws_iam"` (callers sign requests with AWS SigV4) for AWS-native callers. Nexthink's AWS IAM credentials aren't fully functional for API calls yet, so this guide uses the bearer token.

All values below in `<angle brackets>` are placeholders.

---

## What you are protecting

Apple's API does not use a "client secret". An Apple Business API account gives you three things:

| Item | Example | Sensitivity |
| --- | --- | --- |
| **Client ID** | `BUSINESSAPI.00000000-0000-0000-0000-000000000000` | An identifier. Not secret on its own, but keep it private |
| **Key ID** | `00000000-0000-0000-0000-000000000000` | An identifier for the key. Not secret on its own |
| **Private key** (`.pem` file) | EC P-256 key | **The secret.** Anyone holding it can act as your API account and read your organization's device data |

The private key plays the role of the "client secret". The function uses it to sign a short-lived token request (a JWT client assertion). The key itself is never sent to Apple, never logged and never returned to callers.

There is one more secret, which you create yourself:

| Item | Sensitivity |
| --- | --- |
| **Bearer token** | Lets a caller (Nexthink) use the function. Anyone holding it can look up your organization's devices, but can't get the Apple key or change anything |

**The rules for the private key:**

1. It lives in exactly one place: an AWS Secrets Manager secret.
2. Only the function's execution role can read it, plus, if you choose, one break-glass admin role.
3. It never goes into git, Terraform variables, `.tfvars` files, Terraform state, environment variables, CI/CD settings, tickets, email, chat, or AI assistants.
4. The downloaded `.pem` file is deleted as soon as the secret exists. If the secret is ever lost, you create a new key in Apple Business; you do not keep a spare copy.

**The rules for the bearer token:**

1. It is generated randomly (256 bits) and stored in its own Secrets Manager secret.
2. It leaves AWS once: pasted directly into Nexthink's credentials, or shared through your password manager. Never by email, chat, tickets or documents.
3. It **never expires or refreshes on its own**, so it is rotated by hand every 90 days, when someone who had it leaves, and immediately if it may have leaked (step 11).

---

## Prerequisites

- An AWS account and a role that can create IAM roles, Lambda functions, CloudWatch log groups, and (step 2) KMS keys and Secrets Manager secrets
- [Terraform](https://developer.hashicorp.com/terraform/install) 1.5 or later
- [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), [`jq`](https://jqlang.org/) and `openssl`
- A workstation you trust for handling the private key: your own managed machine, with disk encryption on
- An Apple Business account with the **Organization Administrator** role (Apple School Manager: **Administrator**)

Check which AWS account and region you are about to use:

```bash
aws sts get-caller-identity --query Arn --output text
```

```bash
aws configure get region
```

---

## Step 1: Create the Apple API account and key

1. Sign in to [Apple Business](https://business.apple.com).
2. Go to **Settings > API** and create an API account for this integration. Use a name that says what it is for, such as "AWS device lookup", so it is easy to revoke later.
3. Download the private key (`.pem`) when it is offered. **Save it to a local folder that is not synced to the cloud.** On a Mac, `~/Downloads` is safe only if iCloud Drive's "Desktop & Documents" and other sync tools don't cover it.
4. Copy the **Client ID** and the **Key ID**. They are **different values**. Putting the Client ID in the Key ID field is a common mistake, and Apple rejects it with HTTP 400.

Use a dedicated API account for this function, not one shared with other tools. You can then rotate or revoke it without affecting anything else.

---

## Step 2 (recommended): Create a KMS key for the secrets

By default Secrets Manager encrypts with the AWS-managed `aws/secretsmanager` key, which **any** principal in the account with Secrets Manager read permission can use. A customer-managed key adds a second lock: a caller needs permission on both the secret and the key.

```bash
aws kms create-key --description "Encrypts the Apple Business device lookup secrets" --query KeyMetadata.Arn --output text
```

Note the ARN it prints, then give it a friendly name:

```bash
aws kms create-alias --alias-name alias/abm-api-secret --target-key-id <key-arn>
```

Enable automatic rotation of the KMS key material:

```bash
aws kms enable-key-rotation --key-id <key-arn>
```

You will pass `<key-arn>` to Terraform as `kms_key_arn`. Skip this step to use the AWS-managed key, and leave `kms_key_arn` unset.

---

## Step 3: Store the Apple credentials in Secrets Manager

Run this on your trusted workstation. It reads the `.pem` file and sends it straight to Secrets Manager through a pipe, so **no intermediate file is written** and the key never appears on screen or in shell history.

With the KMS key from step 2:

```bash
jq -n --arg client_id "<client-id>" --arg key_id "<key-id>" --rawfile private_key_pem "<path-to-downloaded-key.pem>" '{client_id:$client_id, key_id:$key_id, private_key_pem:$private_key_pem}' | aws secretsmanager create-secret --name abm/api-credentials --description "Apple Business API credentials for the device lookup function" --kms-key-id alias/abm-api-secret --secret-string file:///dev/stdin --query ARN --output text
```

Without a customer-managed key, run the same command without `--kms-key-id alias/abm-api-secret`.

Check the secret has the right shape **without printing any values**:

```bash
aws secretsmanager get-secret-value --secret-id abm/api-credentials --query SecretString --output text | jq '{keys: keys, key_id_differs_from_client_id: (.key_id != .client_id), pem_header: (.private_key_pem | split("\n")[0])}'
```

You should see the three keys, `key_id_differs_from_client_id: true`, and `pem_header: "-----BEGIN PRIVATE KEY-----"` (or `EC PRIVATE KEY`).

Now **delete the downloaded key file**, and empty the Trash:

```bash
rm "<path-to-downloaded-key.pem>"
```

Also delete it from any other place it landed: the browser's download history, a USB drive, email attachments, and so on.

---

## Step 4: Create the bearer token secret

This generates a random 256-bit token, stores it in Secrets Manager, and copies it to your clipboard **without printing it** (macOS `pbcopy`; on Linux use `xclip -selection clipboard` or `wl-copy`). With the KMS key from step 2:

```bash
( TOKEN="$(openssl rand -hex 32)" && jq -n --arg token "$TOKEN" '{token:$token}' | aws secretsmanager create-secret --name abm/nexthink-bearer-token --description "Bearer token Nexthink uses to call the device lookup function" --kms-key-id alias/abm-api-secret --secret-string file:///dev/stdin --query ARN --output text && printf %s "$TOKEN" | pbcopy && echo "Token copied to the clipboard" )
```

Without a customer-managed key, leave out `--kms-key-id alias/abm-api-secret`.

You'll paste the token into Nexthink in step 9. Until then you can copy something else to clear the clipboard; to copy the token again later:

```bash
aws secretsmanager get-secret-value --secret-id abm/nexthink-bearer-token --query SecretString --output text | jq -r .token | pbcopy
```

The secret's format is `{"token": "..."}`, with an optional `"previous_token"` during rotation. Tokens shorter than 32 characters are refused (the function fails closed with 502).

---

## Step 5: Set up Terraform state

Terraform state from this module **does not contain the private key or the bearer token**. The module only looks up the secrets' ARNs, never their values. State does contain your account ID, ARNs and the Function URL, so treat it as internal:

- Store it in a dedicated S3 bucket with **Block Public Access** on, **versioning** on, and **default encryption** (SSE-KMS preferred).
- Limit who can read the bucket to the people and pipelines that run Terraform.
- Never commit `terraform.tfstate` or `*.tfvars` files. This repo's `.gitignore` already excludes them.

Uncomment and fill in the `backend "s3"` block in `examples/basic/main.tf`. For a quick trial you can skip this and keep local state, but do not commit it.

---

## Step 6: Configure the deployment

Copy the example into your own infrastructure repo (or work in this checkout):

```bash
cd terraform/examples/basic
```

```bash
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`. It only holds **non-secret** settings:

```hcl
region                 = "<region>"
secret_name            = "abm/api-credentials"
auth_token_secret_name = "abm/nexthink-bearer-token"
kms_key_arn            = "<key-arn-from-step-2>"   # omit if you skipped step 2
```

If you use the module from git rather than a local checkout, pin it to a tag or commit so that code changes are reviewed before they reach your account:

```hcl
source = "git::https://<your-git-host>/ab_lambda.git//terraform?ref=<tag>"
```

The module packages `../src` from the repository, so reference it by a **relative path** (as the example does) or a **git source with `//terraform`**. An absolute local path copies only the `terraform/` folder, and the build then fails with "error archiving directory".

### Module inputs

| Variable | Default | Purpose |
| --- | --- | --- |
| `secret_name` | (required) | Name of the Apple secret from step 3. Name, not ARN |
| `auth_mode` | `bearer_token` | `aws_iam` makes the Function URL require SigV4 signing instead (not used by Nexthink yet) |
| `auth_token_secret_name` | `null` | Name of the token secret from step 4. Required for `bearer_token` |
| `function_name` | `abm-device-lookup` | Also names the role (`<name>-role`) and log group |
| `abm_scope` | `business.api` | `school.api` for Apple School Manager |
| `api_base_url` | `https://api-business.apple.com` | `https://api-school.apple.com` for Apple School Manager |
| `kms_key_arn` | `null` | Customer-managed key from step 2 |
| `enable_function_url` | `true` | Must stay `true` for `bearer_token`. `false` (with `aws_iam`) for direct invokes only (see [Private network deployment](#private-network-deployment)) |
| `invoker_principals` | `[]` | Other AWS accounts or role ARNs allowed to invoke the function with AWS credentials. No wildcards |
| `reserved_concurrency` | `null` | Caps concurrent runs. The example sets 5. New accounts with a quota of 10 can't reserve any; remove it there |
| `log_retention_days` | `30` | Log retention |
| `vpc_subnet_ids`, `vpc_security_group_ids` | `[]` | Run inside your VPC |
| `tags` | `{}` | Tags on every resource |

### Module outputs

`function_url`, `function_name`, `function_arn`, `auth_mode`, `execution_role_arn`, `log_group_name`, `secret_arn`, `auth_token_secret_arn`, and `invoke_policy_json` (a ready-made policy for same-account callers that use AWS credentials).

---

## Step 7: Deploy

```bash
terraform init
```

```bash
terraform plan -out=tfplan
```

Read the plan. You should see 7 resources to add (more if you set `invoker_principals` or VPC settings), including:

- `AUTH_TOKEN_SECRET_ID` set in the function's environment: this switches the token check on
- `authorization_type = "NONE"` on the Function URL, and two `aws_lambda_permission` resources that allow calls without AWS signing. That is expected: the function itself rejects any call without the token.

```bash
terraform apply tfplan
```

```bash
terraform output function_url
```

---

## Step 8 (recommended): Lock the secrets to the function

IAM already stops other roles that lack permission. A **resource policy on each secret** adds a hard stop: it denies reading the value to everyone except the function, even administrators with broad permissions. The policy only denies `GetSecretValue`, so admins can still update, rotate or remove the policy itself.

```bash
terraform output -raw execution_role_arn
```

Create `secret-policy.json` (placeholders shown; it contains no secret material):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "OnlyTheLookupFunctionMayRead",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "*",
      "Condition": {
        "StringNotEquals": {
          "aws:PrincipalArn": [
            "<execution-role-arn>",
            "arn:aws:iam::<account-id>:role/<break-glass-admin-role>"
          ]
        }
      }
    }
  ]
}
```

Apply it to both secrets:

```bash
aws secretsmanager put-resource-policy --secret-id abm/api-credentials --resource-policy file://secret-policy.json --block-public-policy
```

```bash
aws secretsmanager put-resource-policy --secret-id abm/nexthink-bearer-token --resource-policy file://secret-policy.json --block-public-policy
```

For the token secret, keep the break-glass role listed: token rotation (step 11) and re-copying the token for Nexthink need to read it. For the Apple secret, drop the break-glass role if you never need to read the value by hand; Apple key rotation uses `put-secret-value`, which this policy does not block. The verification command from step 3 will stop working for anyone not listed, which is expected.

---

## Step 9: Connect Nexthink

Nexthink never receives the Apple credentials, only the bearer token. The **Nexthink admin** creates **Third-party credentials** following Nexthink's [Third-party credentials documentation](https://docs.nexthink.com/configuring_nexthink/bringing-data-into-your-nexthink-instance/integrating-nexthink-with-third-party-tools/outbound-connectors/connector-credentials):

| Field | Value |
| --- | --- |
| Protocol | **HTTPS** |
| URL | The value of `terraform output -raw function_url` |
| Authorization type | **Bearer token** |
| Header prefix | `Bearer` |
| Token | The token from step 4 |

Then create the API call and trigger it from Workspaces as described in the main [README](../README.md#3-create-the-api-call).

**Other callers** that use AWS credentials can still invoke the function directly: same-account callers attach `terraform output -raw invoke_policy_json`; callers in other accounts go in `invoker_principals`.

---

## Step 10: Test

Call the Function URL with the token, read from Secrets Manager inline so it isn't stored in your shell history:

```bash
curl -s -H "Authorization: Bearer $(aws secretsmanager get-secret-value --secret-id abm/nexthink-bearer-token --query SecretString --output text | jq -r .token)" "$(terraform output -raw function_url)?serial=C02XXXXXXXXX&include=assignedServer,appleCareCoverage" | jq
```

Or invoke directly with your AWS credentials:

```bash
aws lambda invoke --function-name "$(terraform output -raw function_name)" --cli-binary-format raw-in-base64-out --payload '{"serial":"C02XXXXXXXXX"}' response.json && jq . response.json
```

Confirm a request **without the token** is refused with `401`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$(terraform output -raw function_url)?serial=C02XXXXXXXXX"
```

| Response | Meaning |
| --- | --- |
| 200 | Working |
| 401 | Missing or wrong token (log line shows `"auth":"rejected"`) |
| 404 | The serial isn't in your organization |
| 400 | The serial isn't 8–14 uppercase letters and digits |
| 502 | Secret or Apple problem. A log line with `"auth":"error"` means the token secret couldn't be read or is invalid. Otherwise check `upstreamStatus`: 400 from Apple usually means a wrong Key ID or Client ID; 401 means the key was revoked or doesn't match |

---

## Step 11: Operate it safely

### Rotate the bearer token

Do this every 90 days and whenever someone who had the token leaves. The token never expires on its own, and it can't rotate automatically because Nexthink must receive the new value, so put the date on your team's calendar. The old token keeps working until Nexthink is updated, so there's no downtime. To see when the token was last changed:

```bash
aws secretsmanager describe-secret --secret-id abm/nexthink-bearer-token --query '{Created:CreatedDate,LastChanged:LastChangedDate}'
```

1. Store a new token, keeping the old one as `previous_token`. The new token is copied to your clipboard:

   ```bash
   ( NEW="$(openssl rand -hex 32)" && aws secretsmanager get-secret-value --secret-id abm/nexthink-bearer-token --query SecretString --output text | jq --arg t "$NEW" '{token:$t, previous_token:.token}' | aws secretsmanager put-secret-value --secret-id abm/nexthink-bearer-token --secret-string file:///dev/stdin --query VersionId --output text && printf %s "$NEW" | pbcopy && echo "New token copied to the clipboard" )
   ```

2. Wait 5 minutes. The function re-reads the token secret at least that often.
3. Paste the new token into the Nexthink credentials, and test the API call.
4. Remove the old token:

   ```bash
   aws secretsmanager get-secret-value --secret-id abm/nexthink-bearer-token --query SecretString --output text | jq '{token}' | aws secretsmanager put-secret-value --secret-id abm/nexthink-bearer-token --secret-string file:///dev/stdin --query VersionId --output text
   ```

**If the token may have leaked,** don't keep `previous_token`. Replace it right away, then update Nexthink. Within 5 minutes the leaked token stops working:

```bash
( NEW="$(openssl rand -hex 32)" && jq -n --arg t "$NEW" '{token:$t}' | aws secretsmanager put-secret-value --secret-id abm/nexthink-bearer-token --secret-string file:///dev/stdin --query VersionId --output text && printf %s "$NEW" | pbcopy && echo "New token copied to the clipboard" )
```

### Rotate the Apple key

Do this on a schedule (for example yearly) and whenever someone who could read the secret leaves.

1. In Apple Business, create a new key for the API account (or a new API account) and download it.
2. Update the secret, then delete the new `.pem` file:

   ```bash
   jq -n --arg client_id "<client-id>" --arg key_id "<new-key-id>" --rawfile private_key_pem "<path-to-new-key.pem>" '{client_id:$client_id, key_id:$key_id, private_key_pem:$private_key_pem}' | aws secretsmanager put-secret-value --secret-id abm/api-credentials --secret-string file:///dev/stdin --query VersionId --output text
   ```

3. The function caches the secret for each container's lifetime. Force fresh containers:

   ```bash
   aws lambda update-function-configuration --function-name "$(terraform output -raw function_name)" --description "Rotated $(date +%Y-%m-%d)"
   ```

   The next `terraform apply` resets the description; that is harmless.

4. Test (step 10), then **revoke the old key in Apple Business**.

### Watch who reads the secrets

Every read is recorded in CloudTrail. Only the execution role (and a break-glass role during token rotation) should appear:

```bash
aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=GetSecretValue --max-results 20 --query 'Events[].{time:EventTime,user:Username,resources:Resources[].ResourceName}'
```

For continuous monitoring, alert on any `GetSecretValue` for these secrets whose caller isn't the execution role, for example with an EventBridge rule on CloudTrail events or a CloudTrail Lake query.

### Logs and abuse

The function logs one line per request: request ID, serial and Apple's HTTP status, or `"auth":"rejected"` for a refused token. It never logs tokens, the signed assertion or secret material. Serial numbers identify your devices, so keep log access limited to the people who need it.

The Function URL is reachable from the internet. Requests without the token are rejected immediately, but each still starts the function briefly. To catch someone probing it, create a CloudWatch metric filter on `"auth":"rejected"` and alarm on it. Setting `reserved_concurrency` caps how much a flood of requests can cost.

### If you suspect the Apple key leaked

1. Revoke the key in Apple Business immediately. This is the only step that actually stops misuse.
2. Create a new key and rotate it in, as above.
3. Review CloudTrail `GetSecretValue` events and Apple Business activity for the exposure window.

---

## Private network deployment

A Function URL is always an internet-reachable endpoint. Nexthink is a cloud service, so it needs that. For other callers that must stay inside your network:

1. Set `auth_mode = "aws_iam"` and `enable_function_url = false`. Callers invoke the function with `lambda:InvokeFunction` instead.
2. Create an **interface VPC endpoint for Lambda** (`com.amazonaws.<region>.lambda`) in the callers' VPC, and add a condition on `aws:SourceVpce` to the callers' IAM policies so calls must arrive through it.
3. To run the function itself inside your VPC, set `vpc_subnet_ids` and `vpc_security_group_ids`. The function still needs **outbound HTTPS** to `account.apple.com` and `api-business.apple.com` (usually through a NAT gateway or an egress proxy you allow-list), and a route to Secrets Manager (a `com.amazonaws.<region>.secretsmanager` interface endpoint keeps that traffic inside AWS). The security group needs outbound TCP 443 only; no inbound rules.

---

## Removing it

```bash
terraform destroy
```

Then delete the Nexthink credentials, delete both secrets (Secrets Manager keeps them recoverable for 7–30 days), schedule deletion of the KMS key if you created one for this, and **revoke the API account or key in Apple Business**:

```bash
aws secretsmanager delete-secret --secret-id abm/api-credentials --recovery-window-in-days 7
```

```bash
aws secretsmanager delete-secret --secret-id abm/nexthink-bearer-token --recovery-window-in-days 7
```

---

## Security checklist

- [ ] The `.pem` file was deleted after creating the secret, and never synced, emailed or committed
- [ ] Both secrets use a customer-managed KMS key (step 2)
- [ ] Both secrets have a resource policy limiting who can read them (step 8)
- [ ] The bearer token was generated randomly, went only into Nexthink, and was never sent by email, chat or ticket
- [ ] A request without the token returns 401 (step 10)
- [ ] Terraform state is in a private, encrypted, versioned bucket
- [ ] `reserved_concurrency` caps usage, if your account quota allows, and rejected tokens raise an alarm
- [ ] A dedicated Apple API account is used for this function only
- [ ] Rotation dates for the token and the Apple key are on the calendar, and CloudTrail reads of the secrets are monitored

## SAM or Terraform?

The repo also contains a SAM template (`template.yaml`). Both deploy the same code with the same bearer-token default; use one per account. The Terraform module adds the cross-account, KMS, concurrency and VPC settings.
