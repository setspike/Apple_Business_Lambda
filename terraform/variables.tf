variable "secret_name" {
  description = "Name (not ARN) of an EXISTING Secrets Manager secret holding client_id, key_id and private_key_pem. Create it before running Terraform; see terraform/README.md."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9/_+=.@-]+$", var.secret_name)) && !startswith(var.secret_name, "arn:")
    error_message = "secret_name must be a secret name such as abm/api-credentials, not an ARN."
  }
}

variable "auth_mode" {
  description = "How Function URL callers authenticate. bearer_token (default, used by Nexthink): callers send \"Authorization: Bearer <token>\" matching the token secret. aws_iam: callers sign requests with AWS SigV4."
  type        = string
  default     = "bearer_token"

  validation {
    condition     = contains(["bearer_token", "aws_iam"], var.auth_mode)
    error_message = "auth_mode must be bearer_token or aws_iam."
  }
}

variable "auth_token_secret_name" {
  description = "Name (not ARN) of an EXISTING Secrets Manager secret holding the caller bearer token as {\"token\": \"...\"}. Required when auth_mode is bearer_token; see terraform/README.md."
  type        = string
  default     = null

  validation {
    condition     = var.auth_token_secret_name == null || (can(regex("^[A-Za-z0-9/_+=.@-]+$", var.auth_token_secret_name)) && !startswith(coalesce(var.auth_token_secret_name, "x"), "arn:"))
    error_message = "auth_token_secret_name must be a secret name such as abm/nexthink-bearer-token, not an ARN."
  }
}

variable "function_name" {
  description = "Name of the Lambda function. Also used to name the IAM role and log group."
  type        = string
  default     = "abm-device-lookup"

  validation {
    condition     = can(regex("^[A-Za-z0-9_-]{1,56}$", var.function_name))
    error_message = "function_name must be 1-56 characters of letters, digits, hyphens or underscores."
  }
}

variable "abm_scope" {
  description = "OAuth scope: business.api for Apple Business, school.api for Apple School Manager."
  type        = string
  default     = "business.api"

  validation {
    condition     = contains(["business.api", "school.api"], var.abm_scope)
    error_message = "abm_scope must be business.api or school.api."
  }
}

variable "api_base_url" {
  description = "Apple API base URL. Use https://api-school.apple.com for Apple School Manager."
  type        = string
  default     = "https://api-business.apple.com"

  validation {
    condition     = can(regex("^https://[A-Za-z0-9.-]+$", var.api_base_url))
    error_message = "api_base_url must be an https:// origin with no path."
  }
}

variable "enable_function_url" {
  description = "Create a Lambda Function URL. Required for bearer_token mode. In aws_iam mode, set false to allow only direct invokes (for example through a Lambda VPC endpoint)."
  type        = bool
  default     = true
}

variable "invoker_principals" {
  description = "AWS account IDs or IAM role/user ARNs, typically in OTHER accounts, allowed to call the function with AWS credentials (the Function URL in aws_iam mode, or direct invokes). Callers in this account only need an identity policy (see the invoke_policy_json output)."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for p in var.invoker_principals :
      can(regex("^[0-9]{12}$", p)) || can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:(role|user)/.+$", p))
    ])
    error_message = "Each invoker principal must be a 12-digit account ID or an IAM role/user ARN. Wildcards are not allowed."
  }
}

variable "reserved_concurrency" {
  description = "Maximum concurrent executions, which caps cost and protects your Apple API rate limit. null leaves the function unreserved. Accounts with a low concurrency quota (new accounts often have 10) cannot reserve any; keep null there."
  type        = number
  default     = null

  validation {
    condition     = var.reserved_concurrency == null || try(var.reserved_concurrency >= 1, false)
    error_message = "reserved_concurrency must be null or at least 1."
  }
}

variable "kms_key_arn" {
  description = "ARN of the customer-managed KMS key that encrypts the secret, if any. Grants the function kms:Decrypt on that key, only via Secrets Manager. Leave null for the AWS-managed aws/secretsmanager key."
  type        = string
  default     = null
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for the function's log group."
  type        = number
  default     = 30
}

variable "vpc_subnet_ids" {
  description = "Optional private subnets to run the function in. They need outbound HTTPS to account.apple.com and api-business.apple.com (for example through a NAT gateway) and a route to Secrets Manager. Set together with vpc_security_group_ids."
  type        = list(string)
  default     = []
}

variable "vpc_security_group_ids" {
  description = "Security groups for the function when vpc_subnet_ids is set. Allow outbound TCP 443 only."
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Tags applied to every resource the module creates."
  type        = map(string)
  default     = {}
}
