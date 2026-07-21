# This ALB must be internet-facing for CloudFront custom-origin reachability;
# ingress remains CloudFront-prefix-list-only plus an unguessable origin header.
#trivy:ignore:AVD-AWS-0053:exp:2026-10-31
resource "aws_lb" "main" {
  name               = substr(local.name, 0, 32)
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = [for subnet in aws_subnet.public : subnet.id]

  enable_deletion_protection = var.alb_deletion_protection
  drop_invalid_header_fields = true
  desync_mitigation_mode     = "strictest"
  idle_timeout               = 65

  # CloudFront appends the actual viewer IP to any supplied chain. Preserve
  # that chain so AlphaNet's right-to-left resolver sees the viewer as the first
  # untrusted hop, instead of rate-limiting the CloudFront edge address.
  xff_header_processing_mode = "preserve"

  tags = {
    Name = local.name
  }
}

resource "aws_lb_target_group" "service" {
  for_each = local.load_balanced_services

  # Keep the service discriminator before the truncation boundary. Supported
  # project names can otherwise collapse several target groups to one name.
  name        = substr("${each.key}-${local.name}", 0, 32)
  port        = each.value.container_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id

  deregistration_delay = 30

  health_check {
    enabled             = true
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 20
    timeout             = 5
    path                = each.value.health_path
    port                = "traffic-port"
    protocol            = "HTTP"
    matcher             = "200"
  }

  tags = {
    Service = each.key
  }
}

resource "aws_lb_listener" "origin" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  certificate_arn   = local.alb_origin_certificate_arn
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"

  default_action {
    type = "fixed-response"

    fixed_response {
      content_type = "text/plain"
      message_body = "Forbidden"
      status_code  = "403"
    }
  }
}

resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.origin.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service["api"].arn
  }

  condition {
    path_pattern {
      values = ["/api/*", "/v1/*", "/health/ready"]
    }
  }

  condition {
    http_header {
      http_header_name = "X-AlphaNet-Origin-Verify"
      values           = [random_password.cloudfront_origin.result]
    }
  }
}

resource "aws_lb_listener_rule" "mcp" {
  listener_arn = aws_lb_listener.origin.arn
  priority     = 20

  action {
    type             = var.mcp_public_enabled ? "forward" : "fixed-response"
    target_group_arn = var.mcp_public_enabled ? aws_lb_target_group.service["mcp"].arn : null

    dynamic "fixed_response" {
      for_each = var.mcp_public_enabled ? [] : [1]
      content {
        content_type = "application/json"
        message_body = "{\"error\":\"not_found\"}"
        status_code  = "404"
      }
    }
  }

  condition {
    path_pattern {
      values = ["/mcp", "/mcp/*"]
    }
  }

  condition {
    http_header {
      http_header_name = "X-AlphaNet-Origin-Verify"
      values           = [random_password.cloudfront_origin.result]
    }
  }
}

resource "aws_lb_listener_rule" "web" {
  listener_arn = aws_lb_listener.origin.arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service["web"].arn
  }

  condition {
    http_header {
      http_header_name = "X-AlphaNet-Origin-Verify"
      values           = [random_password.cloudfront_origin.result]
    }
  }
}

resource "aws_wafv2_web_acl" "edge" {
  provider = aws.global
  count    = var.enable_waf ? 1 : 0

  name        = "${local.name}-edge"
  description = "Managed protections and coarse abuse control for AlphaNet"
  scope       = "CLOUDFRONT"

  default_action {
    allow {}
  }

  rule {
    name     = "aws-ip-reputation"
    priority = 10

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesAmazonIpReputationList"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-ip-reputation"
      sampled_requests_enabled   = false
    }
  }

  rule {
    name     = "aws-known-bad-inputs"
    priority = 20

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-known-bad"
      sampled_requests_enabled   = false
    }
  }

  rule {
    name     = "per-ip-rate-limit"
    priority = 30

    action {
      block {}
    }

    statement {
      rate_based_statement {
        aggregate_key_type = "IP"
        limit              = var.waf_rate_limit
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-rate-limit"
      sampled_requests_enabled   = false
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.name}-edge"
    sampled_requests_enabled   = false
  }
}

# AllViewerExceptHostHeader is required so TLS SNI and the HTTP Host presented
# to the ALB match the dedicated origin certificate. Strip viewer-supplied
# forwarding-host/proto metadata before the managed policy forwards headers;
# CloudFront/ALB then generate the trusted transport metadata themselves.
resource "aws_cloudfront_function" "sanitize_forwarding_headers" {
  name    = "${local.name}-sanitize-forwarding-headers"
  runtime = "cloudfront-js-2.0"
  comment = "Remove viewer-controlled proxy metadata before forwarding"
  publish = true
  code    = <<-JAVASCRIPT
    function handler(event) {
      var request = event.request;
      delete request.headers['forwarded'];
      delete request.headers['x-forwarded-host'];
      delete request.headers['x-forwarded-port'];
      delete request.headers['x-forwarded-proto'];
      return request;
    }
  JAVASCRIPT
}

resource "aws_cloudfront_distribution" "main" {
  enabled         = true
  is_ipv6_enabled = true
  http_version    = "http2and3"
  price_class     = var.cloudfront_price_class
  aliases         = var.domain_name == "" ? [] : [var.domain_name]
  web_acl_id      = var.enable_waf ? aws_wafv2_web_acl.edge[0].arn : null

  origin {
    domain_name = var.alb_origin_domain_name
    origin_id   = "alb-${local.name}"

    custom_header {
      name  = "X-AlphaNet-Origin-Verify"
      value = random_password.cloudfront_origin.result
    }

    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = "https-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_keepalive_timeout = 5
      origin_read_timeout      = 60
    }
  }

  default_cache_behavior {
    target_origin_id       = "alb-${local.name}"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security_headers.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.sanitize_forwarding_headers.arn
    }
  }

  ordered_cache_behavior {
    path_pattern           = "/_next/static/*"
    target_origin_id       = "alb-${local.name}"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security_headers.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = var.domain_name == ""
    acm_certificate_arn            = var.domain_name == "" ? null : var.cloudfront_certificate_arn
    ssl_support_method             = var.domain_name == "" ? null : "sni-only"
    minimum_protocol_version       = var.domain_name == "" ? "TLSv1" : "TLSv1.2_2021"
  }

  tags = {
    Name = local.name
  }

  lifecycle {
    precondition {
      condition     = var.domain_name == "" || var.domain_name != var.alb_origin_domain_name
      error_message = "domain_name and alb_origin_domain_name must be distinct to prevent a Route53 record conflict and CloudFront origin loop."
    }
  }

  depends_on = [
    aws_acm_certificate_validation.alb_origin,
    aws_route53_record.alb_origin_ipv4,
  ]
}

resource "random_password" "cloudfront_origin" {
  length  = 48
  special = false
}

resource "aws_acm_certificate" "alb_origin" {
  count = local.create_alb_origin_certificate ? 1 : 0

  domain_name       = var.alb_origin_domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "alb_origin_certificate_validation" {
  for_each = local.create_alb_origin_certificate ? {
    for option in aws_acm_certificate.alb_origin[0].domain_validation_options :
    option.domain_name => {
      name   = option.resource_record_name
      record = option.resource_record_value
      type   = option.resource_record_type
    }
  } : {}

  zone_id = var.route53_zone_id
  name    = each.value.name
  type    = each.value.type
  ttl     = 60
  records = [each.value.record]
}

resource "aws_acm_certificate_validation" "alb_origin" {
  count = local.create_alb_origin_certificate ? 1 : 0

  certificate_arn         = aws_acm_certificate.alb_origin[0].arn
  validation_record_fqdns = [for record in aws_route53_record.alb_origin_certificate_validation : record.fqdn]
}

resource "aws_route53_record" "alb_origin_ipv4" {
  count = var.route53_zone_id != "" ? 1 : 0

  zone_id = var.route53_zone_id
  name    = var.alb_origin_domain_name
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "public_ipv4" {
  count = var.domain_name != "" && var.route53_zone_id != "" ? 1 : 0

  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "public_ipv6" {
  count = var.domain_name != "" && var.route53_zone_id != "" ? 1 : 0

  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}
