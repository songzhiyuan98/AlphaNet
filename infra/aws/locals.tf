locals {
  name = "${var.project_name}-${var.environment}"
  azs  = slice(data.aws_availability_zones.available.names, 0, 2)

  az_map = {
    for index, az in local.azs : tostring(index) => {
      az    = az
      index = index
    }
  }

  public_subnet_cidrs = {
    for key, item in local.az_map : key => cidrsubnet(var.vpc_cidr, 4, item.index)
  }
  private_subnet_cidrs = {
    for key, item in local.az_map : key => cidrsubnet(var.vpc_cidr, 4, item.index + 4)
  }
  data_subnet_cidrs = {
    for key, item in local.az_map : key => cidrsubnet(var.vpc_cidr, 4, item.index + 8)
  }

  services              = toset(["web", "api", "mcp", "worker", "migrate"])
  long_running_services = toset(["web", "api", "mcp", "worker"])
  load_balanced_services = {
    web = {
      container_port = 3000
      health_path    = "/health"
    }
    api = {
      container_port = 4000
      health_path    = "/health/ready"
    }
    mcp = {
      container_port = 4100
      health_path    = "/health/ready"
    }
  }
  alb_attached_services = setunion(
    toset(["web", "api"]),
    var.mcp_public_enabled ? toset(["mcp"]) : toset([])
  )

  ecr_repository_prefix = var.ecr_repository_prefix
  ecr_repository_names = {
    for service in local.services : service => "${local.ecr_repository_prefix}-${service}"
  }
  container_images = {
    for service in local.services : service =>
    "${data.aws_ecr_repository.service[service].repository_url}@${data.aws_ecr_image.service[service].image_digest}"
  }

  public_origin                 = var.domain_name != "" ? "https://${var.domain_name}" : "https://${aws_cloudfront_distribution.main.domain_name}"
  public_host                   = var.domain_name != "" ? var.domain_name : aws_cloudfront_distribution.main.domain_name
  create_alb_origin_certificate = var.alb_origin_certificate_arn == ""
  alb_origin_certificate_arn    = local.create_alb_origin_certificate ? aws_acm_certificate_validation.alb_origin[0].certificate_arn : var.alb_origin_certificate_arn

  mcp_allowed_hosts = join(",", compact([
    local.public_host,
    var.alb_origin_domain_name,
    aws_lb.main.dns_name,
    "mcp.${aws_service_discovery_private_dns_namespace.main.name}",
    "mcp",
    var.mcp_additional_allowed_hosts,
  ]))

  github_oidc_subjects = var.github_oidc_subjects

  common_tags = merge(var.tags, {
    Environment = var.environment
    ManagedBy   = "terraform"
    Project     = var.project_name
  })
}
