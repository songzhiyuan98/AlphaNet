resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "CloudFront-to-ALB origin traffic only"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name}-alb"
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb_cloudfront_https" {
  security_group_id = aws_security_group.alb.id
  description       = "TLS origin requests from the AWS-managed CloudFront origin fleet"
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront_origin_facing.id
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "alb_operator_https" {
  for_each = toset(var.allow_direct_alb_cidrs)

  security_group_id = aws_security_group.alb.id
  description       = "Temporary direct origin diagnostics"
  cidr_ipv4         = each.value
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_security_group" "service" {
  for_each = local.long_running_services

  name        = "${local.name}-${each.key}"
  description = "AlphaNet ${each.key} Fargate tasks"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name}-${each.key}"
  }
}

resource "aws_security_group" "migration" {
  name        = "${local.name}-migrate"
  description = "Short-lived database migration tasks"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name}-migrate"
  }
}

# ECR, AWS APIs, Resend, and Google OAuth require outbound HTTPS through NAT;
# all non-HTTPS dependency ports are constrained to named SGs below.
#trivy:ignore:AVD-AWS-0104:exp:2026-10-31
resource "aws_vpc_security_group_egress_rule" "service_https" {
  for_each = local.long_running_services

  security_group_id = aws_security_group.service[each.key].id
  description       = "AWS APIs, ECR layers, and approved external HTTPS providers through NAT"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "service_dns_udp" {
  for_each = local.long_running_services

  security_group_id = aws_security_group.service[each.key].id
  description       = "DNS through the VPC resolver"
  cidr_ipv4         = "${cidrhost(var.vpc_cidr, 2)}/32"
  from_port         = 53
  to_port           = 53
  ip_protocol       = "udp"
}

resource "aws_vpc_security_group_egress_rule" "service_dns_tcp" {
  for_each = local.long_running_services

  security_group_id = aws_security_group.service[each.key].id
  description       = "TCP DNS fallback through the VPC resolver"
  cidr_ipv4         = "${cidrhost(var.vpc_cidr, 2)}/32"
  from_port         = 53
  to_port           = 53
  ip_protocol       = "tcp"
}

# Short-lived jobs need ECR, Secrets Manager, and CloudWatch HTTPS through NAT;
# database access is separately constrained to the Aurora SG.
#trivy:ignore:AVD-AWS-0104:exp:2026-10-31
resource "aws_vpc_security_group_egress_rule" "migration_https" {
  security_group_id = aws_security_group.migration.id
  description       = "ECR, Secrets Manager, and CloudWatch through NAT"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "migration_dns_udp" {
  security_group_id = aws_security_group.migration.id
  description       = "DNS through the VPC resolver"
  cidr_ipv4         = "${cidrhost(var.vpc_cidr, 2)}/32"
  from_port         = 53
  to_port           = 53
  ip_protocol       = "udp"
}

resource "aws_vpc_security_group_egress_rule" "migration_dns_tcp" {
  security_group_id = aws_security_group.migration.id
  description       = "TCP DNS fallback through the VPC resolver"
  cidr_ipv4         = "${cidrhost(var.vpc_cidr, 2)}/32"
  from_port         = 53
  to_port           = 53
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "service_from_alb" {
  for_each = local.load_balanced_services

  security_group_id            = aws_security_group.service[each.key].id
  referenced_security_group_id = aws_security_group.alb.id
  description                  = "Only the public ALB may reach this service port"
  from_port                    = each.value.container_port
  to_port                      = each.value.container_port
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_service" {
  for_each = local.load_balanced_services

  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.service[each.key].id
  description                  = "Forward to ${each.key} targets"
  from_port                    = each.value.container_port
  to_port                      = each.value.container_port
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "api_from_web" {
  security_group_id            = aws_security_group.service["api"].id
  referenced_security_group_id = aws_security_group.service["web"].id
  description                  = "Private server-side Web requests"
  from_port                    = 4000
  to_port                      = 4000
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "web_to_api" {
  security_group_id            = aws_security_group.service["web"].id
  referenced_security_group_id = aws_security_group.service["api"].id
  description                  = "Private server-side Web requests to API"
  from_port                    = 4000
  to_port                      = 4000
  ip_protocol                  = "tcp"
}

resource "aws_security_group" "database" {
  name        = "${local.name}-aurora"
  description = "Aurora PostgreSQL from approved application and migration tasks"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name}-aurora"
  }
}

locals {
  database_clients = merge(
    {
      api     = aws_security_group.service["api"].id
      worker  = aws_security_group.service["worker"].id
      migrate = aws_security_group.migration.id
    },
  )
}

resource "aws_vpc_security_group_ingress_rule" "database_client" {
  for_each = local.database_clients

  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = each.value
  description                  = "PostgreSQL from ${each.key}"
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "service_to_database" {
  for_each = toset(["api", "worker"])

  security_group_id            = aws_security_group.service[each.key].id
  referenced_security_group_id = aws_security_group.database.id
  description                  = "PostgreSQL TLS from ${each.key}"
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "migration_to_database" {
  security_group_id            = aws_security_group.migration.id
  referenced_security_group_id = aws_security_group.database.id
  description                  = "PostgreSQL TLS for controlled database jobs"
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_security_group" "valkey" {
  name        = "${local.name}-valkey"
  description = "TLS Valkey from API and MCP only"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name}-valkey"
  }
}

resource "aws_vpc_security_group_ingress_rule" "valkey_client" {
  for_each = toset(["api", "mcp"])

  security_group_id            = aws_security_group.valkey.id
  referenced_security_group_id = aws_security_group.service[each.key].id
  description                  = "Valkey TLS from ${each.key}"
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "service_to_valkey" {
  for_each = toset(["api", "mcp"])

  security_group_id            = aws_security_group.service[each.key].id
  referenced_security_group_id = aws_security_group.valkey.id
  description                  = "Valkey TLS from ${each.key}"
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
}
