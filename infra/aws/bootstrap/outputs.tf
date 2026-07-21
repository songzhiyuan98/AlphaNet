output "state_bucket_name" {
  value = aws_s3_bucket.state.id
}

output "state_kms_key_arn" {
  value = aws_kms_key.state.arn
}

output "backend_base" {
  value = {
    bucket       = aws_s3_bucket.state.id
    encrypt      = true
    kms_key_id   = aws_kms_key.state.arn
    region       = var.aws_region
    use_lockfile = true
  }
}
