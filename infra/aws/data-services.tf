resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = [for subnet in aws_subnet.data : subnet.id]

  tags = {
    Name = local.name
  }
}

resource "aws_rds_cluster_parameter_group" "postgres17" {
  name        = "${local.name}-aurora-postgresql17"
  family      = "aurora-postgresql17"
  description = "AlphaNet privacy and connection-safety settings"

  parameter {
    name         = "idle_in_transaction_session_timeout"
    value        = "60000"
    apply_method = "immediate"
  }

  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }

  parameter {
    name         = "timezone"
    value        = "UTC"
    apply_method = "immediate"
  }
}

# Aurora exposes parameter-value logging controls at the instance parameter
# level. AlphaNet readiness checks SHOW for both settings and rejects traffic
# if either source/value is unsafe.
resource "aws_db_parameter_group" "postgres17" {
  name        = "${local.name}-aurora-postgresql17-instance"
  family      = "aurora-postgresql17"
  description = "AlphaNet instance-level parameter logging controls"

  parameter {
    name         = "log_parameter_max_length"
    value        = "0"
    apply_method = "immediate"
  }

  parameter {
    name         = "log_parameter_max_length_on_error"
    value        = "0"
    apply_method = "immediate"
  }
}

resource "aws_cloudwatch_log_group" "rds_postgresql" {
  count = contains(var.database_cloudwatch_log_exports, "postgresql") ? 1 : 0

  name              = "/aws/rds/cluster/${local.name}/postgresql"
  retention_in_days = var.log_retention_days
}

resource "aws_rds_cluster" "main" {
  cluster_identifier = local.name
  engine             = "aurora-postgresql"
  engine_mode        = "provisioned"
  engine_version     = var.aurora_engine_version
  database_name      = "alphanet"
  master_username    = "alphanet_admin"

  manage_master_user_password = true
  port                        = 5432

  db_cluster_parameter_group_name = aws_rds_cluster_parameter_group.postgres17.name
  db_subnet_group_name            = aws_db_subnet_group.main.name
  vpc_security_group_ids          = [aws_security_group.database.id]

  serverlessv2_scaling_configuration {
    min_capacity             = var.aurora_min_acu
    max_capacity             = var.aurora_max_acu
    seconds_until_auto_pause = var.aurora_min_acu == 0 ? var.aurora_auto_pause_seconds : null
  }

  backup_retention_period      = var.database_backup_retention_days
  preferred_backup_window      = "09:00-10:00"
  preferred_maintenance_window = "sun:10:00-sun:11:00"
  copy_tags_to_snapshot        = true
  deletion_protection          = var.database_deletion_protection
  skip_final_snapshot          = var.database_skip_final_snapshot
  final_snapshot_identifier    = var.database_skip_final_snapshot ? null : "${local.name}-final"
  storage_encrypted            = true
  kms_key_id                   = aws_kms_key.data.arn
  # Runtime and migration clients currently use rotated Secrets Manager
  # passwords. Enable IAM DB auth only when token refresh is implemented.
  iam_database_authentication_enabled = false

  enabled_cloudwatch_logs_exports = var.database_cloudwatch_log_exports

  lifecycle {
    prevent_destroy = false
  }

  depends_on = [aws_cloudwatch_log_group.rds_postgresql]
}

resource "aws_rds_cluster_instance" "main" {
  count = var.aurora_instance_count

  identifier              = "${local.name}-${count.index + 1}"
  cluster_identifier      = aws_rds_cluster.main.id
  instance_class          = "db.serverless"
  engine                  = aws_rds_cluster.main.engine
  engine_version          = aws_rds_cluster.main.engine_version
  db_parameter_group_name = aws_db_parameter_group.postgres17.name

  publicly_accessible                   = false
  auto_minor_version_upgrade            = false
  performance_insights_enabled          = var.database_performance_insights
  performance_insights_retention_period = var.database_performance_insights ? var.database_performance_insights_retention_days : null
  monitoring_interval                   = 0

  lifecycle {
    precondition {
      condition     = !var.database_performance_insights || var.aurora_min_acu >= 2
      error_message = "Performance Insights on Aurora Serverless v2 requires aurora_min_acu >= 2 for this baseline; re-estimate cost before enabling it."
    }
  }
}

resource "aws_elasticache_subnet_group" "main" {
  name       = local.name
  subnet_ids = [for subnet in aws_subnet.data : subnet.id]
}

resource "aws_cloudwatch_log_group" "valkey_slow" {
  name              = "/aws/elasticache/${local.name}/slow"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "valkey_engine" {
  name              = "/aws/elasticache/${local.name}/engine"
  retention_in_days = var.log_retention_days
}

# The native ElastiCache API requires the AUTH token as a plaintext request
# parameter, which would place it in Terraform state. This small CloudFormation
# island uses a Secrets Manager dynamic reference instead: CloudFormation creates
# the random token and resolves it only inside the ElastiCache control plane.
resource "aws_cloudformation_stack" "valkey" {
  name = "${local.name}-valkey"

  template_body = jsonencode({
    AWSTemplateFormatVersion = "2010-09-09"
    Description              = "AlphaNet Valkey with a state-safe generated AUTH token"
    Resources = {
      ValkeyAuthSecret = {
        Type                = "AWS::SecretsManager::Secret"
        DeletionPolicy      = "Retain"
        UpdateReplacePolicy = "Retain"
        Properties = {
          Description = "Generated ElastiCache AUTH token; do not copy into Terraform variables"
          GenerateSecretString = {
            SecretStringTemplate = jsonencode({ username = "default" })
            GenerateStringKey    = "auth_token"
            PasswordLength       = 64
            ExcludePunctuation   = true
          }
          Tags = [for key, value in local.common_tags : { Key = key, Value = value }]
        }
      }
      ValkeyReplicationGroup = {
        Type                = "AWS::ElastiCache::ReplicationGroup"
        DeletionPolicy      = "Snapshot"
        UpdateReplacePolicy = "Snapshot"
        Properties = merge(
          {
            ReplicationGroupId          = substr("${local.name}-valkey", 0, 40)
            ReplicationGroupDescription = "AlphaNet ${var.environment} rate limits and coordination"
            Engine                      = "valkey"
            EngineVersion               = var.valkey_engine_version
            CacheNodeType               = var.valkey_node_type
            ClusterMode                 = "disabled"
            CacheSubnetGroupName        = aws_elasticache_subnet_group.main.name
            SecurityGroupIds            = [aws_security_group.valkey.id]
            Port                        = 6379
            AtRestEncryptionEnabled     = true
            KmsKeyId                    = aws_kms_key.data.arn
            TransitEncryptionEnabled    = true
            TransitEncryptionMode       = "required"
            AuthToken = {
              "Fn::Sub" = "{{resolve:secretsmanager:$${ValkeyAuthSecret}:SecretString:auth_token}}"
            }
            AutomaticFailoverEnabled   = var.valkey_multi_az
            MultiAZEnabled             = var.valkey_multi_az
            AutoMinorVersionUpgrade    = true
            SnapshotRetentionLimit     = var.valkey_snapshot_retention_days
            SnapshotWindow             = "08:00-09:00"
            PreferredMaintenanceWindow = "sun:11:00-sun:12:00"
            LogDeliveryConfigurations = [
              {
                DestinationType = "cloudwatch-logs"
                LogFormat       = "json"
                LogType         = "slow-log"
                DestinationDetails = {
                  CloudWatchLogsDetails = {
                    LogGroup = aws_cloudwatch_log_group.valkey_slow.name
                  }
                }
              },
              {
                DestinationType = "cloudwatch-logs"
                LogFormat       = "json"
                LogType         = "engine-log"
                DestinationDetails = {
                  CloudWatchLogsDetails = {
                    LogGroup = aws_cloudwatch_log_group.valkey_engine.name
                  }
                }
              },
            ]
            Tags = [for key, value in local.common_tags : { Key = key, Value = value }]
          },
          var.valkey_multi_az ? {
            NumCacheClusters = 2
          } : {},
        )
      }
    }
    Outputs = {
      AuthSecretArn = {
        Value = { Ref = "ValkeyAuthSecret" }
      }
      PrimaryEndpointAddress = {
        Value = { "Fn::GetAtt" = ["ValkeyReplicationGroup", "PrimaryEndPoint.Address"] }
      }
      Port = {
        Value = { "Fn::GetAtt" = ["ValkeyReplicationGroup", "PrimaryEndPoint.Port"] }
      }
      ReplicationGroupId = {
        Value = { Ref = "ValkeyReplicationGroup" }
      }
    }
  })

  timeout_in_minutes = 45

  depends_on = [
    aws_cloudwatch_log_group.valkey_engine,
    aws_cloudwatch_log_group.valkey_slow,
  ]
}
