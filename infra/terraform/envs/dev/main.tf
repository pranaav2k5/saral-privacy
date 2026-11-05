provider "aws" {
  region = "ap-south-1"

  default_tags {
    tags = {
      project     = "saral-privacy"
      environment = "dev"
      managed_by  = "terraform"
    }
  }
}

module "audit_anchor" {
  source = "../../modules/audit_anchor_bucket"

  environment = "dev"
  bucket_name = var.audit_anchor_bucket_name
}
