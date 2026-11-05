output "bucket_id" {
  description = "Name of the audit anchor bucket."
  value       = aws_s3_bucket.this.id
}

output "bucket_arn" {
  description = "ARN of the audit anchor bucket."
  value       = aws_s3_bucket.this.arn
}

output "object_lock_mode" {
  description = "Object Lock default retention mode applied to the bucket."
  value       = local.object_lock_mode
}
