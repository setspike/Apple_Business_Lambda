# Deploying with Terraform

This module deploys the Apple Business device lookup function into **your own AWS account**. It creates:

- the Lambda function (Node.js 22, arm64), built straight from `src/` with no build step
- an execution role that can **only** write its own logs and read **one** secret
- an IAM-authenticated Function URL (`AWS_IAM`; this module never creates a public URL)
- a CloudWatch log group with a retention period
- optional permissions for other AWS accounts or roles to call the function

It does **not** create or read the Apple credentials. You put those into Secrets Manager yourself (step 3), so the private key never passes through Terraform or its state file.

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

**The rules for the private key:**

1. It lives in exactly one place: an AWS Secrets Manager secret.
2. Only the function's execution role can read it, plus, if you choose, one break-glass admin role.
3. It never goes into git, Terraform variables, `.tfvars` files, Terraform state, environment variables, CI/CD settings, tickets, email, chat, or AI assistants.
4. The downloaded `.pem` file is deleted as soon as the secret exists. If the secret is ever lost, you create a new key in Apple Business; you do not keep a spare copy.

---

## Prerequisites

- An AWS account and a role that can create IAM roles, Lambda functions, CloudWatch log groups, and (step 2) KMS keys and Secrets Manager secrets
- [Terraform](https://developer.hashicorp.com/terraform/install) 1.5 or later
- [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) and [`jq`](https://jqlang.org/)
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

## Step 2 (recommended): Create a KMS key for the secret

By default Secrets Manager encrypts with the AWS-managed `aws/secretsmanager` key, which **any** principal in the account with Secrets Manager read permission can use. A customer-managed key adds a second lock: a caller needs permission on both the secret and the key.

```bash
aws kms create-key --description "Encrypts the Apple Business API secret" --query KeyMetadata.Arn --output text
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

## Step 3: Store the credentials in Secrets Manager

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

## Step 4: Set up Terraform state

Terraform state from this module **does not contain the private key**. The module only looks up the secret's ARN, never its value. State does contain your account ID, ARNs and the Function URL, so treat it as internal:

- Store it in a dedicated S3 bucket with **Block Public Access** on, **versioning** on, and **default encryption** (SSE-KMS preferred).
- Limit who can read the bucket to the people and pipelines that run Terraform.
- Never commit `terraform.tfstate` or `*.tfvars` files. This repo's `.gitignore` already excludes them.

Uncomment and fill in the `backend "s3"` block in `examples/basic/main.tf`. For a quick trial you can skip this and keep local state, but do not commit it.

---

## Step 5: Configure the deployment

Copy the example into your own infrastructure repo (or work in this checkout):

```bash
cd terraform/examples/basic
```

```bash
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`. It only holds **non-secret** settings:

```hcl
region      = "<region>"
secret_name = "abm/api-credentials"
kms_key_arn = "<key-arn-from-step-2>"   # omit if you skipped step 2
```

If you use the module from git rather than a local checkout, pin it to a tag or commit so that code changes are reviewed before they reach your account:

```hcl
source = "git::https://<your-git-host>/ab_lambda.git//terraform?ref=<tag>"
```

### Module inputs

| Variable | Default | Purpose |
| --- | --- | --- |
| `secret_name` | (required) | Name of the secret from step 3. Name, not ARN |
| `function_name` | `abm-device-lookup` | Also names the role (`<name>-role`) and log group |
| `abm_scope` | `business.api` | `school.api` for Apple School Manager |
| `api_base_url` | `https://api-business.apple.com` | `https://api-school.apple.com` for Apple School Manager |
| `kms_key_arn` | `null` | Customer-managed key from step 2 |
| `enable_function_url` | `true` | `false` for direct invokes only (see [Private network deployment](#private-network-deployment)) |
| `invoker_principals` | `[]` | Other AWS accounts or role ARNs allowed to call the function. No wildcards |
| `reserved_concurrency` | `null` | Caps concurrent runs. The example sets 5. New accounts with a quota of 10 can't reserve any; remove it there |
| `log_retention_days` | `30` | Log retention |
| `vpc_subnet_ids`, `vpc_security_group_ids` | `[]` | Run inside your VPC |
| `tags` | `{}` | Tags on every resource |

### Module outputs

`function_url`, `function_name`, `function_arn`, `execution_role_arn`, `log_group_name`, `secret_arn`, and `invoke_policy_json` (a ready-made policy for callers in the same account).

---

## Step 6: Deploy

```bash
terraform init
```

```bash
terraform plan -out=tfplan
```

Read the plan. You should see 5 resources to add (more if you set `invoker_principals` or VPC settings), and `authorization_type = "AWS_IAM"` on the Function URL.

```bash
terraform apply tfplan
```

```bash
terraform output function_url
```

---

## Step 7 (recommended): Lock the secret to the function

IAM already stops other roles that lack permission. A **resource policy on the secret** adds a hard stop: it denies reading the value to everyone except the function, even administrators with broad permissions. The policy only denies `GetSecretValue`, so admins can still update, rotate or remove the policy itself.

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

```bash
aws secretsmanager put-resource-policy --secret-id abm/api-credentials --resource-policy file://secret-policy.json --block-public-policy
```

Drop the break-glass role if you never need to read the value by hand. (Rotation in step 10 uses `put-secret-value`, which this policy does not block.) The verification command from step 3 will stop working for anyone not listed, which is expected.

---

## Step 8: Allow callers

Callers never receive the Apple credentials. They get permission to call the function, under their own AWS identity.

**Callers in the same account** (IAM users, roles, SSO permission sets): attach the policy from:

```bash
terraform output -raw invoke_policy_json
```

**Callers in other accounts:** add their account ID or role ARN to `invoker_principals` and apply again. They still need an identity policy in their own account allowing `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` on your function ARN.

**SaaS tools** that assume a role in your account (for example with an External ID): create that role with a trust policy for the vendor, and attach `invoke_policy_json` to it.

Prefer roles and SSO over long-lived IAM user access keys. Grant access per caller, so each one can be removed on its own.

---

## Step 9: Test

Every request to the Function URL must be signed with AWS SigV4 for service `lambda`. With the curl built into macOS and most Linux distributions (credentials stay in a subshell):

```bash
( eval "$(aws configure export-credentials --format env)"; set --; [ -n "$AWS_SESSION_TOKEN" ] && set -- -H "x-amz-security-token: $AWS_SESSION_TOKEN"; curl -s --aws-sigv4 "aws:amz:<region>:lambda" --user "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" "$@" "$(terraform output -raw function_url)?serial=C02XXXXXXXXX&include=assignedServer,appleCareCoverage" | jq )
```

Or invoke directly:

```bash
aws lambda invoke --function-name "$(terraform output -raw function_name)" --cli-binary-format raw-in-base64-out --payload '{"serial":"C02XXXXXXXXX"}' response.json && jq . response.json
```

Confirm an **unsigned** request is refused with `403 Forbidden`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$(terraform output -raw function_url)?serial=C02XXXXXXXXX"
```

| Response | Meaning |
| --- | --- |
| 200 | Working |
| 404 | The serial isn't in your organization |
| 400 | The serial isn't 8–14 uppercase letters and digits |
| 403 (signed) | The caller lacks invoke permission, or the signature uses the wrong service or region |
| 502 | Secret or Apple problem. Check the log line's `upstreamStatus`: 400 from Apple usually means a wrong Key ID or Client ID; 401 means the key was revoked or doesn't match |

---

## Step 10: Operate it safely

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

4. Test (step 9), then **revoke the old key in Apple Business**.

### Watch who reads the secret

Every read is recorded in CloudTrail. Only the execution role should appear:

```bash
aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=GetSecretValue --max-results 20 --query 'Events[].{time:EventTime,user:Username,resources:Resources[].ResourceName}'
```

For continuous monitoring, alert on any `GetSecretValue` for this secret whose caller isn't the execution role, for example with an EventBridge rule on CloudTrail events or a CloudTrail Lake query.

### Logs

The function logs one line per request: request ID, serial and Apple's HTTP status. It never logs tokens, the signed assertion or secret material. Serial numbers identify your devices, so keep log access limited to the people who need it.

### If you suspect the key leaked

1. Revoke the key in Apple Business immediately. This is the only step that actually stops misuse.
2. Create a new key and rotate it in, as above.
3. Review CloudTrail `GetSecretValue` events and Apple Business activity for the exposure window.

---

## Private network deployment

A Function URL is always an internet-reachable endpoint, even though it only accepts signed requests. For a deployment reachable only from inside your network:

1. Set `enable_function_url = false`. Callers invoke the function with `lambda:InvokeFunction` instead.
2. Create an **interface VPC endpoint for Lambda** (`com.amazonaws.<region>.lambda`) in the callers' VPC, and add a condition on `aws:SourceVpce` to the callers' IAM policies so calls must arrive through it.
3. To run the function itself inside your VPC, set `vpc_subnet_ids` and `vpc_security_group_ids`. The function still needs **outbound HTTPS** to `account.apple.com` and `api-business.apple.com` (usually through a NAT gateway or an egress proxy you allow-list), and a route to Secrets Manager (a `com.amazonaws.<region>.secretsmanager` interface endpoint keeps that traffic inside AWS). The security group needs outbound TCP 443 only; no inbound rules.

---

## Removing it

```bash
terraform destroy
```

Then delete the secret (Secrets Manager keeps it recoverable for 7–30 days), schedule deletion of the KMS key if you created one for this, and **revoke the API account or key in Apple Business**:

```bash
aws secretsmanager delete-secret --secret-id abm/api-credentials --recovery-window-in-days 7
```

---

## Security checklist

- [ ] The `.pem` file was deleted after creating the secret, and never synced, emailed or committed
- [ ] The secret uses a customer-managed KMS key (step 2)
- [ ] The secret has a resource policy allowing only the execution role to read it (step 7)
- [ ] Terraform state is in a private, encrypted, versioned bucket
- [ ] The Function URL is `AWS_IAM`, and every caller has its own identity and permission
- [ ] `reserved_concurrency` caps usage, if your account quota allows
- [ ] A dedicated Apple API account is used for this function only
- [ ] A rotation date is on the calendar, and CloudTrail reads of the secret are monitored

## SAM or Terraform?

The repo also contains a SAM template (`template.yaml`). Both deploy the same code; use one per account. The Terraform module has no public-URL option and adds the cross-account, KMS and VPC settings.
