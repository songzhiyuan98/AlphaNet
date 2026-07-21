\set ON_ERROR_STOP on

SELECT current_user = :'runtime_role' AS connected_as_runtime
\gset
\if :connected_as_runtime
\else
  SELECT 1 / 0 AS smoke_test_must_connect_as_runtime_role;
\endif

BEGIN;

SELECT
  pg_catalog.gen_random_uuid()::text AS user_id,
  pg_catalog.gen_random_uuid()::text AS actor_id,
  pg_catalog.gen_random_uuid()::text AS agent_id,
  pg_catalog.gen_random_uuid()::text AS policy_id,
  pg_catalog.gen_random_uuid()::text AS aggregate_id,
  pg_catalog.gen_random_uuid()::text AS consumer_suffix
\gset

INSERT INTO auth.users (
  id,
  name,
  email,
  email_verified,
  created_at,
  updated_at
)
VALUES (
  :'user_id',
  'AWS runtime smoke',
  :'user_id' || '@runtime-smoke.invalid',
  true,
  clock_timestamp(),
  clock_timestamp()
);

SELECT id::text AS owner_id
FROM platform.owners
WHERE auth_user_id = :'user_id'
\gset

INSERT INTO auth.verifications (
  id,
  identifier,
  value,
  expires_at,
  created_at,
  updated_at
)
VALUES (
  pg_catalog.gen_random_uuid(),
  'runtime-smoke:' || :'user_id',
  :'user_id',
  clock_timestamp() + interval '5 minutes',
  clock_timestamp(),
  clock_timestamp()
);

DELETE FROM auth.verifications
WHERE identifier = 'runtime-smoke:' || :'user_id';

INSERT INTO platform.actors (
  id,
  kind,
  owner_id,
  handle,
  display_name,
  status
)
VALUES (
  :'actor_id',
  'agent',
  :'owner_id',
  'smoke-' || left(replace(:'actor_id', '-', ''), 20),
  'AWS runtime smoke Agent',
  'draft'
);

INSERT INTO platform.agents (
  id,
  actor_id,
  owner_id,
  discovery_tags,
  status
)
VALUES (
  :'agent_id',
  :'actor_id',
  :'owner_id',
  ARRAY['risk']::text[],
  'draft'
);

INSERT INTO platform.agent_policies (
  id,
  agent_id,
  tier,
  defaults_version,
  policy_schema_version,
  version,
  rules,
  is_active,
  configured_by_owner_id
)
VALUES (
  :'policy_id',
  :'agent_id',
  'assisted',
  'agent-permission-defaults-v1',
  1,
  1,
  '{}'::jsonb,
  true,
  :'owner_id'
);

UPDATE platform.actors
SET bio = 'Least-privilege runtime smoke test'
WHERE id = :'actor_id';

UPDATE platform.agents
SET discovery_tags = ARRAY['risk', 'valuation']::text[]
WHERE id = :'agent_id';

SET CONSTRAINTS ALL IMMEDIATE;

INSERT INTO system.outbox_events (
  aggregate_type,
  aggregate_id,
  aggregate_sequence,
  event_type,
  payload
)
VALUES (
  'aws_runtime_smoke',
  :'aggregate_id',
  1,
  'aws_runtime_smoke.created',
  '{}'::jsonb
)
RETURNING id::text AS event_id
\gset

INSERT INTO system.outbox_consumers (
  consumer_name,
  event_types,
  replay_from
)
VALUES (
  'aws-runtime-smoke:' || :'consumer_suffix',
  ARRAY['aws_runtime_smoke.created']::text[],
  '-infinity'::timestamptz
);

INSERT INTO system.outbox_consumer_deliveries (
  consumer_name,
  event_id,
  max_attempts,
  available_at
)
VALUES (
  'aws-runtime-smoke:' || :'consumer_suffix',
  :'event_id',
  3,
  clock_timestamp()
);

UPDATE system.outbox_consumer_deliveries
SET lease_owner = 'runtime-smoke',
    lease_expires_at = clock_timestamp() + interval '30 seconds',
    attempts = 1,
    updated_at = clock_timestamp()
WHERE consumer_name = 'aws-runtime-smoke:' || :'consumer_suffix'
  AND event_id = :'event_id';

INSERT INTO system.outbox_consumer_receipts (
  consumer_name,
  event_id,
  result
)
VALUES (
  'aws-runtime-smoke:' || :'consumer_suffix',
  :'event_id',
  '{"smoke":"passed"}'::jsonb
);

SELECT (
  EXISTS (
    SELECT 1
    FROM platform.agents
    WHERE id = :'agent_id'
      AND discovery_tags = ARRAY['risk', 'valuation']::text[]
  )
  AND EXISTS (
    SELECT 1
    FROM system.outbox_aggregate_heads
    WHERE aggregate_type = 'aws_runtime_smoke'
      AND aggregate_id = :'aggregate_id'
      AND last_sequence = 1
  )
  AND EXISTS (
    SELECT 1
    FROM system.outbox_consumer_receipts
    WHERE consumer_name = 'aws-runtime-smoke:' || :'consumer_suffix'
      AND event_id = :'event_id'
  )
) AS runtime_smoke_passed
\gset

\if :runtime_smoke_passed
\else
  SELECT 1 / 0 AS runtime_smoke_invariant_failed;
\endif

ROLLBACK;

\echo 'AlphaNet AWS runtime SQL smoke test passed and rolled back.'
