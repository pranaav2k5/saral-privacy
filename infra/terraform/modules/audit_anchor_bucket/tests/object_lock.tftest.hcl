mock_provider "aws" {}

variables {
  bucket_name = "saral-audit-anchor-test"
}

run "prod_uses_compliance_mode_for_seven_years" {
  command = plan

  variables {
    environment = "prod"
  }

  assert {
    condition     = aws_s3_bucket_object_lock_configuration.this.rule[0].default_retention[0].mode == "COMPLIANCE"
    error_message = "prod must use COMPLIANCE mode"
  }

  assert {
    condition     = aws_s3_bucket_object_lock_configuration.this.rule[0].default_retention[0].years == 7
    error_message = "default retention must be 7 years"
  }
}

run "dev_uses_governance_mode" {
  command = plan

  variables {
    environment = "dev"
  }

  assert {
    condition     = aws_s3_bucket_object_lock_configuration.this.rule[0].default_retention[0].mode == "GOVERNANCE"
    error_message = "dev must use GOVERNANCE mode"
  }
}

run "staging_uses_governance_mode" {
  command = plan

  variables {
    environment = "staging"
  }

  assert {
    condition     = aws_s3_bucket_object_lock_configuration.this.rule[0].default_retention[0].mode == "GOVERNANCE"
    error_message = "staging must use GOVERNANCE mode"
  }
}

run "bucket_is_locked_versioned_and_private" {
  command = plan

  variables {
    environment = "prod"
  }

  assert {
    condition     = aws_s3_bucket.this.object_lock_enabled == true
    error_message = "Object Lock must be enabled on the bucket"
  }

  assert {
    condition     = aws_s3_bucket_versioning.this.versioning_configuration[0].status == "Enabled"
    error_message = "versioning must be enabled (required by Object Lock)"
  }

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.this.block_public_acls,
      aws_s3_bucket_public_access_block.this.block_public_policy,
      aws_s3_bucket_public_access_block.this.ignore_public_acls,
      aws_s3_bucket_public_access_block.this.restrict_public_buckets,
    ])
    error_message = "all four public access block flags must be true"
  }
}

run "unknown_environment_is_rejected" {
  command = plan

  variables {
    environment = "qa"
  }

  expect_failures = [var.environment]
}

run "zero_retention_is_rejected" {
  command = plan

  variables {
    environment     = "prod"
    retention_years = 0
  }

  expect_failures = [var.retention_years]
}

run "incomplete_multipart_uploads_are_aborted" {
  command = plan

  variables {
    environment = "prod"
  }

  assert {
    condition     = aws_s3_bucket_lifecycle_configuration.this.rule[0].status == "Enabled"
    error_message = "lifecycle rule must be enabled"
  }

  assert {
    condition     = aws_s3_bucket_lifecycle_configuration.this.rule[0].abort_incomplete_multipart_upload[0].days_after_initiation == 7
    error_message = "incomplete multipart uploads must be aborted after 7 days"
  }
}

run "prod_retention_below_seven_years_is_rejected" {
  command = plan

  variables {
    environment     = "prod"
    retention_years = 6
  }

  expect_failures = [var.retention_years]
}

run "prod_retention_above_ten_years_is_rejected" {
  command = plan

  variables {
    environment     = "prod"
    retention_years = 11
  }

  expect_failures = [var.retention_years]
}

run "prod_accepts_ten_years" {
  command = plan

  variables {
    environment     = "prod"
    retention_years = 10
  }

  assert {
    condition     = aws_s3_bucket_object_lock_configuration.this.rule[0].default_retention[0].years == 10
    error_message = "prod must accept a 10 year retention"
  }
}

run "non_prod_may_use_short_retention" {
  command = plan

  variables {
    environment     = "dev"
    retention_years = 1
  }

  assert {
    condition     = aws_s3_bucket_object_lock_configuration.this.rule[0].default_retention[0].years == 1
    error_message = "dev must accept a 1 year retention"
  }
}
