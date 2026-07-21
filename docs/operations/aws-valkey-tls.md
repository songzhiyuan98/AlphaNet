# AWS ElastiCache Valkey connection contract

AlphaNet uses Redis as a rate-limit, cache, and wake-up dependency. PostgreSQL
remains the durable outbox and source of truth. A cache loss must not lose
community content or outbox work.

## Supported production topology

For the current `ioredis.Redis` single-endpoint client, use one of:

- ElastiCache Serverless for Valkey; or
- a node-based Valkey replication group with cluster mode disabled, TLS, a
  primary endpoint, Multi-AZ, and automatic failover.

Do not supply a cluster-mode-enabled configuration endpoint to the current
client. AWS requires a cluster-protocol-aware client for that topology, while
AlphaNet currently constructs `Redis`, not `Redis.Cluster`. A future sharding
change needs an explicit application migration and load/failover test before
changing ElastiCache mode. AWS documents the endpoint distinction in
[Finding connection endpoints](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Endpoints.html)
and the one-way cluster-mode transition constraints in
[Modifying cluster mode](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/modify-cluster-mode.html).

## TLS and authentication

All production connections use `rediss://`; plain `redis://` is rejected by the
deployment configuration. Serverless caches always enable in-transit encryption,
and node-based replication groups must set `TransitEncryptionEnabled=true`.
AWS describes this behavior in
[ElastiCache in-transit encryption](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/in-transit-encryption.html).

Use an ElastiCache RBAC user/password (preferred) or long-lived AUTH token stored
in Secrets Manager. Percent-encode both username and password before placing
them in the secret URL:

```text
rediss://<encoded-user>:<encoded-password>@<primary-endpoint>:6379/0
```

Never print or assemble this URL in a CI shell trace. Security groups allow
6379 only from the ECS service/task security group. Do not disable hostname or
certificate verification, and do not add `rejectUnauthorized=false`.

The pinned `ioredis` client natively derives TLS and RBAC credentials from a
`rediss://` URL; `packages/database/src/index.test.ts` locks this compatibility
without opening a network connection. The upstream behavior is documented by
[ioredis TLS options](https://github.com/redis/ioredis#tls-options).

## Why IAM auth is deferred

ElastiCache IAM tokens expire after 15 minutes, and IAM-authenticated
connections are disconnected after 12 hours unless reauthenticated. AWS
recommends a credentials-provider-capable client for automatic refresh. The
current static `REDIS_URL` and long-lived `ioredis` clients do not implement that
lifecycle, so granting IAM authentication now would produce delayed production
failures. See
[Authenticating with IAM](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/auth-iam.html).

## Deployment checks

Before routing traffic, each service must prove:

1. its `REDIS_URL` scheme is `rediss`;
2. DNS resolves only inside the VPC path intended by the infrastructure;
3. `PING` succeeds with the runtime RBAC user;
4. an invalid credential fails closed;
5. rate-limit operations work from at least two API tasks;
6. a primary failover reconnects within the service readiness/retry budget;
7. Worker progress continues through PostgreSQL polling while Valkey is
   unavailable.

Rotate the RBAC password with a two-user handover: create a replacement user,
add it to the user group, deploy the new URL, verify all tasks, and only then
remove the old user. This avoids the reconnect gap of an in-place single-secret
replacement.

## Stack deletion and snapshot recovery

The CloudFormation island snapshots the replication group and retains its AUTH
secret on deletion or replacement. The secret uses an AWS-generated physical
name so a retained copy cannot block a replacement stack with a fixed-name
collision. Before any planned destroy, record the `valkey_auth_secret_arn`
and `data_kms_key_arn` outputs and the final snapshot identifier in the
incident/change record. The data CMK is destroy-protected because neither the
retained secret nor snapshot is useful after its encryption key is deleted.

A retained secret is not automatically attached to a newly created stack.
Snapshot recovery must be a reviewed operation that restores the cache with the
matching retained token (or performs a coordinated token rotation), updates the
application secret, and proves invalid/valid credential behavior before traffic
returns. Retained secrets are intentional recovery assets: locate them by the
AlphaNet environment tags, and schedule deletion with a recovery window only
after every dependent snapshot and incident hold has expired. Never force-delete
them as part of routine Terraform cleanup.
