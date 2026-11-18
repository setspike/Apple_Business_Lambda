output "function_name" {
  description = "Lambda function name."
  value       = aws_lambda_function.function.function_name
}

output "function_arn" {
  description = "Lambda function ARN."
  value       = aws_lambda_function.function.arn
}

output "auth_mode" {
  description = "How Function URL callers authenticate: bearer_token or aws_iam."
  value       = var.auth_mode
}

output "function_url" {
  description = "Function URL (null when enable_function_url is false)."
  value       = var.enable_function_url ? aws_lambda_function_url.function[0].function_url : null
}

output "execution_role_arn" {
  description = "The function's execution role. Use it in the secret's resource policy (see terraform/README.md)."
  value       = aws_iam_role.function.arn
}

output "log_group_name" {
  description = "CloudWatch log group for the function."
  value       = aws_cloudwatch_log_group.function.name
}

output "secret_arn" {
  description = "ARN of the Apple credentials secret."
  value       = data.aws_secretsmanager_secret.abm.arn
}

output "auth_token_secret_arn" {
  description = "ARN of the bearer token secret (null in aws_iam mode)."
  value       = one(data.aws_secretsmanager_secret.auth_token[*].arn)
}

output "invoke_policy_json" {
  description = "IAM policy for same-account callers that use AWS credentials (aws_iam mode, or direct invokes)."
  value       = data.aws_iam_policy_document.invoke.json
}
