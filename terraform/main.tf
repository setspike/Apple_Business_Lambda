# Apple Business device lookup: Lambda + Function URL.
#
# auth_mode = "bearer_token" (default): the URL needs no AWS signing, and the
# function rejects any request without a valid bearer token (401).
# auth_mode = "aws_iam": the URL requires SigV4-signed requests.
#
# This module never reads a secret's VALUE. It only looks up secret metadata
# (ARNs), so neither the Apple private key nor the bearer token enters
# Terraform state.

locals {
  use_vpc      = length(var.vpc_subnet_ids) > 0
  bearer_token = var.auth_mode == "bearer_token"
  iam_url      = var.enable_function_url && !local.bearer_token

  # Each invoker gets one permission per action it needs.
  invoker_grants = merge(
    local.iam_url ? {
      for p in var.invoker_principals : "url-${p}" => { principal = p, action = "lambda:InvokeFunctionUrl", via_url = true }
    } : {},
    {
      for p in var.invoker_principals : "invoke-${p}" => { principal = p, action = "lambda:InvokeFunction", via_url = local.iam_url }
    },
  )
}

data "aws_partition" "current" {}
data "aws_region" "current" {}

# Metadata only. Do NOT replace this with aws_secretsmanager_secret_version:
# that would copy the private key into Terraform state in plain text.
data "aws_secretsmanager_secret" "abm" {
  name = var.secret_name
}

data "aws_secretsmanager_secret" "auth_token" {
  # Skipped when the name is missing so the clearer precondition below reports it.
  count = local.bearer_token && var.auth_token_secret_name != null ? 1 : 0
  name  = var.auth_token_secret_name
}

data "archive_file" "function" {
  type        = "zip"
  source_dir  = "${path.module}/../src"
  output_path = "${path.module}/.build/${var.function_name}.zip"
}

# --- Logging ------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "function" {
  name              = "/aws/lambda/${var.function_name}"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

# --- Execution role -----------------------------------------------------------

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "function" {
  name               = "${var.function_name}-role"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "function" {
  statement {
    sid       = "WriteOwnLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.function.arn}:*"]
  }

  statement {
    sid       = "ReadOwnSecretsOnly"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = concat([data.aws_secretsmanager_secret.abm.arn], data.aws_secretsmanager_secret.auth_token[*].arn)
  }

  dynamic "statement" {
    for_each = var.kms_key_arn == null ? [] : [var.kms_key_arn]
    content {
      sid       = "DecryptSecretViaSecretsManager"
      actions   = ["kms:Decrypt"]
      resources = [statement.value]
      condition {
        test     = "StringEquals"
        variable = "kms:ViaService"
        values   = ["secretsmanager.${data.aws_region.current.region}.amazonaws.com"]
      }
    }
  }
}

resource "aws_iam_role_policy" "function" {
  name   = "abm-device-lookup"
  role   = aws_iam_role.function.id
  policy = data.aws_iam_policy_document.function.json
}

resource "aws_iam_role_policy_attachment" "vpc" {
  count      = local.use_vpc ? 1 : 0
  role       = aws_iam_role.function.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

# --- Function -----------------------------------------------------------------

resource "aws_lambda_function" "function" {
  function_name    = var.function_name
  description      = "Look up an Apple Business device by serial number"
  role             = aws_iam_role.function.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  memory_size      = 256
  timeout          = 10
  filename         = data.archive_file.function.output_path
  source_code_hash = data.archive_file.function.output_base64sha256

  reserved_concurrent_executions = var.reserved_concurrency

  environment {
    variables = {
      ABM_SECRET_ID    = var.secret_name
      ABM_SCOPE        = var.abm_scope
      ABM_API_BASE_URL = var.api_base_url
      # Empty disables the token check (aws_iam mode).
      AUTH_TOKEN_SECRET_ID = local.bearer_token ? var.auth_token_secret_name : ""
    }
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.function.name
  }

  dynamic "vpc_config" {
    for_each = local.use_vpc ? [1] : []
    content {
      subnet_ids         = var.vpc_subnet_ids
      security_group_ids = var.vpc_security_group_ids
    }
  }

  tags = var.tags

  lifecycle {
    precondition {
      condition     = !local.use_vpc || length(var.vpc_security_group_ids) > 0
      error_message = "vpc_security_group_ids is required when vpc_subnet_ids is set."
    }
    precondition {
      condition     = !local.bearer_token || var.auth_token_secret_name != null
      error_message = "auth_token_secret_name is required when auth_mode is bearer_token."
    }
    precondition {
      condition     = !local.bearer_token || var.enable_function_url
      error_message = "auth_mode bearer_token needs enable_function_url = true; use aws_iam for direct invokes only."
    }
  }

  depends_on = [
    aws_iam_role_policy.function,
    aws_iam_role_policy_attachment.vpc,
  ]
}

resource "aws_lambda_function_url" "function" {
  count         = var.enable_function_url ? 1 : 0
  function_name = aws_lambda_function.function.function_name
  # NONE only together with the function's own bearer-token check.
  authorization_type = local.bearer_token ? "NONE" : "AWS_IAM"
}

# A Function URL without AWS signing needs both of these permissions. Requests
# still need a valid bearer token, which the function checks.
resource "aws_lambda_permission" "url_public" {
  count                  = local.bearer_token && var.enable_function_url ? 1 : 0
  statement_id           = "FunctionUrlNoAwsSigning"
  function_name          = aws_lambda_function.function.function_name
  action                 = "lambda:InvokeFunctionUrl"
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "url_public_invoke" {
  count                    = local.bearer_token && var.enable_function_url ? 1 : 0
  statement_id             = "FunctionUrlNoAwsSigningInvoke"
  function_name            = aws_lambda_function.function.function_name
  action                   = "lambda:InvokeFunction"
  principal                = "*"
  invoked_via_function_url = true
}

# --- Who may call it ----------------------------------------------------------

resource "aws_lambda_permission" "invoker" {
  for_each = local.invoker_grants

  statement_id_prefix      = "abm-invoker-"
  function_name            = aws_lambda_function.function.function_name
  action                   = each.value.action
  principal                = each.value.principal
  function_url_auth_type   = each.value.action == "lambda:InvokeFunctionUrl" ? "AWS_IAM" : null
  invoked_via_function_url = each.value.action == "lambda:InvokeFunction" && each.value.via_url ? true : null
}

# Identity policy that same-account callers (users, roles, SSO permission sets)
# can attach to be allowed to call the function. Exposed as an output.
data "aws_iam_policy_document" "invoke" {
  dynamic "statement" {
    for_each = local.iam_url ? [1] : []
    content {
      sid       = "InvokeAbmLookupUrl"
      actions   = ["lambda:InvokeFunctionUrl"]
      resources = [aws_lambda_function.function.arn]
      condition {
        test     = "StringEquals"
        variable = "lambda:FunctionUrlAuthType"
        values   = ["AWS_IAM"]
      }
    }
  }

  statement {
    sid       = "InvokeAbmLookup"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.function.arn]
  }
}
