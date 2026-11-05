# Partial configuration: supply bucket, key, region via
#   terraform init -backend-config=../backend.hcl
terraform {
  backend "s3" {}
}
