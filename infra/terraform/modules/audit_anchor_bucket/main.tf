locals {
  # COMPLIANCE cannot be shortened or removed by anyone, including the root account,
  # so it is used only in prod. Test data locked for years would be a pure cost.
  object_lock_mode = var.environment == "prod" ? "COMPLIANCE" : "GOVERNANCE"
}

resource "aws_s3_bucket" "this" {
  # checkov:skip=CKV_AWS_18:Access logging needs a log bucket; arrives with the logging module. CloudTrail data events cover object access meanwhile.
  # checkov:skip=CKV_AWS_144:Replication to ap-south-2 arrives with the disaster-recovery plan. Data must stay in India; anchors hold no personal data.
  # checkov:skip=CKV_AWS_145:Customer-managed KMS key arrives with the KMS module; AES256 applies until then.
  # checkov:skip=CKV2_AWS_62:Nothing consumes anchor-write events yet.
  bucket              = var.bucket_name
  object_lock_enabled = true
}

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket = aws_s3_bucket.this.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# AES256 for now; switch to a customer-managed KMS key when the KMS module lands.
resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_object_lock_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    default_retention {
      mode  = local.object_lock_mode
      years = var.retention_years
    }
  }

  depends_on = [aws_s3_bucket_versioning.this]
}

# Object Lock governs object retention; this only keeps failed uploads from accumulating.
resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.this]
}
