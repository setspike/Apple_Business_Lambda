# Minimal root configuration for the ABM device lookup module.
# Copy this folder into your own infrastructure repo, configure the backend,
# then follow terraform/README.md.

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.28.0, < 7.0.0"
    }
  }

  # Keep state in an encrypted, versioned, private S3 bucket. State holds no
  # private key, but it does hold account IDs and resource ARNs.
  # backend "s3" {
  #   bucket       = "<your-terraform-state-bucket>"
  #   key          = "abm-device-lookup/terraform.tfstate"
  #   region       = "<region>"
  #   encrypt      = true
  #   use_lockfile = true
  # }
}

provider "aws" {
  region = var.region
}

variable "region" {
  description = "AWS region to deploy into."
  type        = string
}

variable "secret_name" {
  description = "Name of the existing Secrets Manager secret with the Apple API credentials."
  type        = string
}

variable "auth_token_secret_name" {
  description = "Name of the existing Secrets Manager secret with the caller bearer token."
  type        = string
}

variable "kms_key_arn" {
  description = "Customer-managed KMS key ARN that encrypts the secret (recommended), or null."
  type        = string
  default     = null
}

variable "invoker_principals" {
  description = "Other AWS accounts or roles allowed to invoke the function directly with AWS credentials."
  type        = list(string)
  default     = []
}

module "abm_device_lookup" {
  # From a checkout of this repo. To use it from git instead, pin a tag:
  # source = "git::https://<your-git-host>/ab_lambda.git//terraform?ref=<tag>"
  source = "../.."

  secret_name = var.secret_name

  # Callers (Nexthink) authenticate with "Authorization: Bearer <token>".
  auth_mode              = "bearer_token"
  auth_token_secret_name = var.auth_token_secret_name

  kms_key_arn        = var.kms_key_arn
  invoker_principals = var.invoker_principals

  # Caps concurrent runs. Remove if your account's concurrency quota is low.
  reserved_concurrency = 5

  tags = {
    Application = "abm-device-lookup"
  }
}

output "function_url" {
  value = module.abm_device_lookup.function_url
}

output "function_name" {
  value = module.abm_device_lookup.function_name
}

output "execution_role_arn" {
  value = module.abm_device_lookup.execution_role_arn
}

output "invoke_policy_json" {
  value = module.abm_device_lookup.invoke_policy_json
}
