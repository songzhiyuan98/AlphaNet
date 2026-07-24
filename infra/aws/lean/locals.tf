locals {
  name = "${var.project_name}-${var.environment}"

  public_subnet_cidr = cidrsubnet(var.vpc_cidr, 8, 0)
  data_subnet_cidrs = {
    a = cidrsubnet(var.vpc_cidr, 8, 10)
    b = cidrsubnet(var.vpc_cidr, 8, 11)
  }

  service_targets = toset(["api", "mcp", "migrate", "web", "worker"])
  ecr_prefix = (
    "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com/" != "" ?
    "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com/${var.ecr_repository_prefix}" :
    ""
  )
}
