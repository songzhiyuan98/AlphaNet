data "aws_caller_identity" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}
data "aws_ec2_managed_prefix_list" "cloudfront_origin" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = local.name
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = local.name
  }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  availability_zone       = data.aws_availability_zones.available.names[0]
  cidr_block              = local.public_subnet_cidr
  map_public_ip_on_launch = false

  tags = {
    Name = "${local.name}-public"
    Tier = "application"
  }
}

resource "aws_subnet" "data" {
  for_each = local.data_subnet_cidrs

  vpc_id            = aws_vpc.main.id
  availability_zone = data.aws_availability_zones.available.names[
    each.key == "a" ? 0 : 1
  ]
  cidr_block              = each.value
  map_public_ip_on_launch = false

  tags = {
    Name = "${local.name}-data-${each.key}"
    Tier = "data"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "${local.name}-public"
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "data" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "${local.name}-data"
  }
}

resource "aws_route_table_association" "data" {
  for_each = aws_subnet.data

  subnet_id      = each.value.id
  route_table_id = aws_route_table.data.id
}

resource "aws_security_group" "application" {
  name        = "${local.name}-application"
  description = "CloudFront-only HTTP ingress and reviewed application egress"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "CloudFront origin-facing HTTP"
    protocol        = "tcp"
    from_port       = 80
    to_port         = 80
    prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront_origin.id]
  }

  egress {
    description = "HTTPS dependencies, ECR, SSM, OAuth, and email"
    protocol    = "tcp"
    from_port   = 443
    to_port     = 443
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "VPC DNS over UDP"
    protocol    = "udp"
    from_port   = 53
    to_port     = 53
    cidr_blocks = [cidrhost(var.vpc_cidr, 2)]
  }

  egress {
    description = "VPC DNS over TCP"
    protocol    = "tcp"
    from_port   = 53
    to_port     = 53
    cidr_blocks = [cidrhost(var.vpc_cidr, 2)]
  }

  egress {
    description     = "PostgreSQL system of record"
    protocol        = "tcp"
    from_port       = 5432
    to_port         = 5432
    security_groups = [aws_security_group.database.id]
  }

  tags = {
    Name = "${local.name}-application"
  }
}

resource "aws_security_group" "database" {
  name        = "${local.name}-database"
  description = "PostgreSQL only from the AlphaNet application node"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "PostgreSQL from application"
    protocol        = "tcp"
    from_port       = 5432
    to_port         = 5432
    security_groups = [aws_security_group.application.id]
  }

  egress = []

  tags = {
    Name = "${local.name}-database"
  }
}
