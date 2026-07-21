resource "aws_sns_topic" "operations" {
  name              = "${local.name}-operations"
  kms_master_key_id = aws_kms_key.notifications.arn

  lifecycle {
    precondition {
      condition     = var.environment != "production" || length(var.operations_alert_emails) > 0
      error_message = "Production requires at least one operations_alert_emails endpoint; confirm every SNS subscription before launch."
    }
  }
}

data "aws_iam_policy_document" "operations_topic" {
  statement {
    sid    = "AccountOwnerAdministration"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }

    actions   = ["sns:*"]
    resources = [aws_sns_topic.operations.arn]
  }

  statement {
    sid    = "AWSMonitoringPublish"
    effect = "Allow"

    principals {
      type = "Service"
      identifiers = [
        "cloudwatch.amazonaws.com",
      ]
    }

    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.operations.arn]

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "operations" {
  arn    = aws_sns_topic.operations.arn
  policy = data.aws_iam_policy_document.operations_topic.json
}

resource "aws_sns_topic_subscription" "operations_email" {
  for_each = var.operations_alert_emails

  topic_arn = aws_sns_topic.operations.arn
  protocol  = "email"
  endpoint  = each.value
}

# CloudFront metrics and alarms live in us-east-1. SNS alarm actions are
# regional, so edge failures use a matching topic instead of silently targeting
# the regional service-alarm topic in us-west-2.
resource "aws_sns_topic" "edge_operations" {
  provider          = aws.global
  name              = "${local.name}-edge-operations"
  kms_master_key_id = aws_kms_key.edge_notifications.arn
}

data "aws_iam_policy_document" "edge_operations_topic" {
  statement {
    sid    = "AccountOwnerAdministration"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }

    actions   = ["sns:*"]
    resources = [aws_sns_topic.edge_operations.arn]
  }

  statement {
    sid    = "CloudWatchPublish"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.edge_operations.arn]

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "edge_operations" {
  provider = aws.global
  arn      = aws_sns_topic.edge_operations.arn
  policy   = data.aws_iam_policy_document.edge_operations_topic.json
}

resource "aws_sns_topic_subscription" "edge_operations_email" {
  provider = aws.global
  for_each = var.operations_alert_emails

  topic_arn = aws_sns_topic.edge_operations.arn
  protocol  = "email"
  endpoint  = each.value
}

resource "aws_cloudwatch_metric_alarm" "cloudfront_5xx" {
  provider = aws.global

  alarm_name          = "${local.name}-cloudfront-5xx-rate"
  alarm_description   = "CloudFront 5xx errors include origin TLS, DNS, ALB, and application failures"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 2
  period              = 300
  statistic           = "Average"
  namespace           = "AWS/CloudFront"
  metric_name         = "5xxErrorRate"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.edge_operations.arn]
  ok_actions          = [aws_sns_topic.edge_operations.arn]

  dimensions = {
    DistributionId = aws_cloudfront_distribution.main.id
    Region         = "Global"
  }

  depends_on = [aws_sns_topic_policy.edge_operations]
}

resource "aws_cloudwatch_metric_alarm" "alb_target_5xx" {
  alarm_name          = "${local.name}-alb-target-5xx"
  alarm_description   = "Application targets are returning elevated 5xx responses"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 10
  period              = 300
  statistic           = "Sum"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]

  dimensions = {
    LoadBalancer = aws_lb.main.arn_suffix
  }
}

resource "aws_cloudwatch_metric_alarm" "alb_load_balancer_5xx" {
  alarm_name          = "${local.name}-alb-5xx"
  alarm_description   = "ALB-generated 5xx responses can indicate routing or target-connectivity failures"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 5
  period              = 300
  statistic           = "Sum"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_ELB_5XX_Count"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]

  dimensions = {
    LoadBalancer = aws_lb.main.arn_suffix
  }
}

resource "aws_cloudwatch_metric_alarm" "alb_unhealthy_targets" {
  for_each = {
    for service, config in local.load_balanced_services : service => config
    if contains(local.alb_attached_services, service) && var.service_desired_count[service] > 0
  }

  alarm_name          = "${local.name}-${each.key}-unhealthy-targets"
  alarm_description   = "${each.key} has unhealthy ALB targets"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 0
  period              = 60
  statistic           = "Maximum"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]

  dimensions = {
    LoadBalancer = aws_lb.main.arn_suffix
    TargetGroup  = aws_lb_target_group.service[each.key].arn_suffix
  }
}

resource "aws_cloudwatch_metric_alarm" "ecs_cpu" {
  for_each = local.long_running_services

  alarm_name          = "${local.name}-${each.key}-cpu-high"
  alarm_description   = "${each.key} ECS CPU utilization is sustained above 85 percent"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 85
  period              = 300
  statistic           = "Average"
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]

  dimensions = {
    ClusterName = aws_ecs_cluster.main.name
    ServiceName = aws_ecs_service.app[each.key].name
  }
}

resource "aws_cloudwatch_metric_alarm" "worker_running_tasks" {
  count = var.service_desired_count["worker"] > 0 ? 1 : 0

  alarm_name          = "${local.name}-worker-running-tasks-low"
  alarm_description   = "Worker has no running task; CPU-only alarms are silent when the process is absent"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = var.service_desired_count["worker"]
  period              = 60
  statistic           = "Minimum"
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]

  dimensions = {
    ClusterName = aws_ecs_cluster.main.name
    ServiceName = aws_ecs_service.app["worker"].name
  }
}

resource "aws_cloudwatch_metric_alarm" "aurora_cpu" {
  for_each = { for index, instance in aws_rds_cluster_instance.main : tostring(index) => instance }

  alarm_name          = "${local.name}-aurora-${each.key}-cpu-high"
  alarm_description   = "Aurora instance CPU utilization is sustained above 85 percent"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 85
  period              = 300
  statistic           = "Average"
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]

  dimensions = {
    DBInstanceIdentifier = each.value.identifier
  }
}

resource "aws_cloudwatch_metric_alarm" "aurora_connections" {
  alarm_name          = "${local.name}-aurora-connections-high"
  alarm_description   = "Aurora connections are approaching the first-quarter operating envelope"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 300
  period              = 300
  statistic           = "Maximum"
  namespace           = "AWS/RDS"
  metric_name         = "DatabaseConnections"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]

  dimensions = {
    DBClusterIdentifier = aws_rds_cluster.main.cluster_identifier
  }
}

resource "aws_cloudwatch_metric_alarm" "valkey_cpu" {
  alarm_name          = "${local.name}-valkey-cpu-high"
  alarm_description   = "Valkey engine CPU utilization is sustained above 80 percent"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 80
  period              = 300
  statistic           = "Average"
  namespace           = "AWS/ElastiCache"
  metric_name         = "EngineCPUUtilization"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]

  dimensions = {
    ReplicationGroupId = aws_cloudformation_stack.valkey.outputs["ReplicationGroupId"]
    Role               = "Primary"
  }
}

resource "aws_cloudwatch_metric_alarm" "valkey_memory" {
  alarm_name          = "${local.name}-valkey-memory-high"
  alarm_description   = "Primary Valkey memory counted for eviction is sustained above 80 percent"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 80
  period              = 300
  statistic           = "Average"
  namespace           = "AWS/ElastiCache"
  metric_name         = "DatabaseMemoryUsageCountedForEvictPercentage"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]

  dimensions = {
    ReplicationGroupId = aws_cloudformation_stack.valkey.outputs["ReplicationGroupId"]
    Role               = "Primary"
  }
}

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = local.name
  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "ALB requests, latency, and target errors"
          region = var.aws_region
          period = 300
          metrics = [
            ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", aws_lb.main.arn_suffix, { stat = "Sum" }],
            [".", "TargetResponseTime", ".", ".", { stat = "p95", yAxis = "right" }],
            [".", "HTTPCode_Target_5XX_Count", ".", ".", { stat = "Sum" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "ECS CPU by service"
          region = var.aws_region
          period = 300
          metrics = [for service in local.long_running_services : [
            "AWS/ECS",
            "CPUUtilization",
            "ClusterName",
            aws_ecs_cluster.main.name,
            "ServiceName",
            aws_ecs_service.app[service].name,
          ]]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "Aurora capacity"
          region = var.aws_region
          period = 300
          metrics = [
            ["AWS/RDS", "DatabaseConnections", "DBClusterIdentifier", aws_rds_cluster.main.cluster_identifier],
            [".", "ServerlessDatabaseCapacity", ".", ".", { yAxis = "right" }],
            [".", "ACUUtilization", ".", ".", { yAxis = "right" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "Valkey"
          region = var.aws_region
          period = 300
          metrics = [
            ["AWS/ElastiCache", "EngineCPUUtilization", "ReplicationGroupId", aws_cloudformation_stack.valkey.outputs["ReplicationGroupId"], "Role", "Primary"],
            [".", "DatabaseMemoryUsageCountedForEvictPercentage", ".", ".", ".", ".", { yAxis = "right" }],
          ]
        }
      },
    ]
  })
}
