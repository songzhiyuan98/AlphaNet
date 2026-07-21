SET LOCAL search_path = pg_catalog;

-- Policy documents are deliberately small and closed-schema. Custom omits
-- keys to inherit Assisted defaults; it never invents an operation name.
CREATE FUNCTION platform.agent_policy_rules_are_valid(
  tier text,
  defaults_version text,
  policy_schema_version integer,
  rules jsonb
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
DECLARE
  member record;
  assisted_v1 constant jsonb := jsonb_build_object(
    'browse', 'allow',
    'content_read', 'allow',
    'notification_read', 'allow',
    'search', 'allow',
    'reaction_write', 'allow',
    'follow_write', 'allow',
    'content_write', 'require_approval',
    'reply_write', 'require_approval',
    'edit_own_content', 'require_approval',
    'delete_own_content', 'require_approval'
  );
BEGIN
  IF tier NOT IN ('read_only', 'assisted', 'autonomous', 'custom')
    OR defaults_version IS DISTINCT FROM 'agent-permission-defaults-v1'
    OR policy_schema_version IS DISTINCT FROM 1
    OR rules IS NULL
    OR jsonb_typeof(rules) <> 'object'
    OR octet_length(convert_to(rules::text, 'UTF8')) > 16384 THEN
    RETURN false;
  END IF;

  IF tier <> 'custom' THEN
    -- 000004 materialized this exact Assisted document. Keep it readable
    -- during rolling upgrades; all new standard policies store {}.
    RETURN rules = '{}'::jsonb
      OR (tier = 'assisted' AND rules = assisted_v1);
  END IF;

  FOR member IN
    SELECT entry.key, entry.value
    FROM jsonb_each(rules) AS entry(key, value)
  LOOP
    IF member.key NOT IN (
      'browse',
      'content_read',
      'notification_read',
      'search',
      'reaction_write',
      'follow_write',
      'content_write',
      'reply_write',
      'edit_own_content',
      'delete_own_content'
    )
      OR jsonb_typeof(member.value) <> 'string' THEN
      RETURN false;
    END IF;

    IF member.key IN (
      'browse',
      'content_read',
      'notification_read',
      'search',
      'reaction_write',
      'follow_write'
    ) AND member.value #>> '{}' NOT IN ('allow', 'deny') THEN
      RETURN false;
    END IF;

    IF member.key IN (
      'content_write',
      'reply_write',
      'edit_own_content',
      'delete_own_content'
    ) AND member.value #>> '{}' NOT IN (
      'allow',
      'require_approval',
      'deny'
    ) THEN
      RETURN false;
    END IF;
  END LOOP;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION platform.agent_policy_rules_are_valid(
  text,
  text,
  integer,
  jsonb
) FROM PUBLIC;

ALTER TABLE platform.agent_policies
  ADD CONSTRAINT agent_policies_rules_valid
  CHECK (
    platform.agent_policy_rules_are_valid(
      tier,
      defaults_version,
      policy_schema_version,
      rules
    )
  );

-- A Credential is an immutable authority snapshot. Tier alone cannot express
-- Custom safely, so pin the same defaults/schema/rules metadata as the active
-- policy at issuance and preserve it through rotation.
ALTER TABLE platform.credentials
  ADD COLUMN policy_ceiling_defaults_version text NOT NULL
    DEFAULT 'agent-permission-defaults-v1',
  ADD COLUMN policy_ceiling_schema_version integer NOT NULL DEFAULT 1,
  ADD COLUMN policy_ceiling_rules jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Before this migration Custom ceilings had no rule document and therefore
-- evaluated fail-closed. Preserve that authority boundary for legacy rows.
UPDATE platform.credentials
SET policy_ceiling_rules = jsonb_build_object(
  'browse', 'deny',
  'content_read', 'deny',
  'notification_read', 'deny',
  'search', 'deny',
  'reaction_write', 'deny',
  'follow_write', 'deny',
  'content_write', 'deny',
  'reply_write', 'deny',
  'edit_own_content', 'deny',
  'delete_own_content', 'deny'
)
WHERE policy_ceiling = 'custom';

ALTER TABLE platform.credentials
  ADD CONSTRAINT credentials_policy_ceiling_rules_valid
  CHECK (
    platform.agent_policy_rules_are_valid(
      policy_ceiling,
      policy_ceiling_defaults_version,
      policy_ceiling_schema_version,
      policy_ceiling_rules
    )
  );

COMMENT ON COLUMN platform.credentials.policy_ceiling_rules IS
  'Immutable compact policy-rule snapshot taken at issuance. Missing Custom keys inherit the pinned Assisted defaults version.';

-- The runtime role can insert Credentials, so the database must bind every
-- new authority snapshot to trusted state. This also makes rolling deploys
-- safe: an older binary can continue issuing/rotating standard-tier keys via
-- the new column defaults, while an old Custom rotation fails closed instead
-- of replacing an all-deny snapshot with an empty Assisted-like document.
CREATE OR REPLACE FUNCTION platform.validate_credential_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  owner_record record;
  agent_record record;
  policy_record record;
  predecessor_record record;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'credentials'
    OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Credential insert validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  SELECT owner.status, owner.email_verified_at, owner.deleted_at
  INTO owner_record
  FROM platform.owners AS owner
  WHERE owner.id = NEW.owner_id
  FOR UPDATE;

  IF NOT FOUND
    OR owner_record.status IS DISTINCT FROM 'active'
    OR owner_record.email_verified_at IS NULL
    OR owner_record.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION
      'only an active, verified Owner may issue a Credential'
      USING ERRCODE = '42501';
  END IF;

  -- Take the serialization lock in its own command. Under Read Committed a
  -- later command in this VOLATILE trigger receives a fresh snapshot after a
  -- concurrent policy transaction releases this lock. Keeping the policy
  -- join in this locking query could otherwise retain the pre-wait snapshot.
  SELECT
    agent.owner_id,
    agent.status,
    agent.deleted_at
  INTO agent_record
  FROM platform.agents AS agent
  WHERE agent.id = NEW.agent_id
  FOR UPDATE;

  IF NOT FOUND
    OR agent_record.owner_id IS DISTINCT FROM NEW.owner_id
    OR agent_record.status IS DISTINCT FROM 'active'
    OR agent_record.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION
      'Credentials may only be issued to an active Agent owned by the Owner'
      USING ERRCODE = '42501';
  END IF;

  SELECT
    policy.tier AS policy_tier,
    policy.defaults_version AS policy_defaults_version,
    policy.policy_schema_version,
    CASE
      WHEN policy.tier = 'custom' THEN policy.rules
      ELSE '{}'::jsonb
    END AS policy_rules
  INTO policy_record
  FROM platform.agent_policies AS policy
  WHERE policy.agent_id = NEW.agent_id
    AND policy.is_active
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Credentials require exactly one active Agent policy'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.replaces_credential_id IS NULL THEN
    IF NEW.policy_ceiling IS DISTINCT FROM policy_record.policy_tier
      OR NEW.policy_ceiling_defaults_version IS DISTINCT FROM
        policy_record.policy_defaults_version
      OR NEW.policy_ceiling_schema_version IS DISTINCT FROM
        policy_record.policy_schema_version
      OR NEW.policy_ceiling_rules IS DISTINCT FROM policy_record.policy_rules THEN
      RAISE EXCEPTION
        'a new Credential ceiling must snapshot the active Agent policy'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT
      credential.owner_id,
      credential.agent_id,
      credential.name,
      credential.credential_type,
      credential.scopes,
      credential.audience,
      credential.policy_ceiling,
      credential.policy_ceiling_defaults_version,
      credential.policy_ceiling_schema_version,
      credential.policy_ceiling_rules,
      credential.revoked_at
    INTO predecessor_record
    FROM platform.credentials AS credential
    WHERE credential.id = NEW.replaces_credential_id;

    IF NOT FOUND
      OR predecessor_record.owner_id IS DISTINCT FROM NEW.owner_id
      OR predecessor_record.agent_id IS DISTINCT FROM NEW.agent_id
      OR predecessor_record.name IS DISTINCT FROM NEW.name
      OR predecessor_record.credential_type IS DISTINCT FROM NEW.credential_type
      OR predecessor_record.scopes IS DISTINCT FROM NEW.scopes
      OR predecessor_record.audience IS DISTINCT FROM NEW.audience
      OR predecessor_record.policy_ceiling IS DISTINCT FROM NEW.policy_ceiling
      OR predecessor_record.policy_ceiling_defaults_version IS DISTINCT FROM
        NEW.policy_ceiling_defaults_version
      OR predecessor_record.policy_ceiling_schema_version IS DISTINCT FROM
        NEW.policy_ceiling_schema_version
      OR predecessor_record.policy_ceiling_rules IS DISTINCT FROM
        NEW.policy_ceiling_rules
      OR predecessor_record.revoked_at IS NULL THEN
      RAISE EXCEPTION
        'a rotated Credential must preserve its revoked predecessor authority and ownership chain'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION platform.validate_credential_insert() FROM PUBLIC;

CREATE OR REPLACE FUNCTION platform.prepare_credential_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'credentials'
    OR TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION
      'Credential update trigger invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
    OR NEW.name IS DISTINCT FROM OLD.name
    OR NEW.credential_type IS DISTINCT FROM OLD.credential_type
    OR NEW.token_prefix IS DISTINCT FROM OLD.token_prefix
    OR NEW.secret_digest IS DISTINCT FROM OLD.secret_digest
    OR NEW.pepper_version IS DISTINCT FROM OLD.pepper_version
    OR NEW.scopes IS DISTINCT FROM OLD.scopes
    OR NEW.audience IS DISTINCT FROM OLD.audience
    OR NEW.policy_ceiling IS DISTINCT FROM OLD.policy_ceiling
    OR NEW.policy_ceiling_defaults_version IS DISTINCT FROM
      OLD.policy_ceiling_defaults_version
    OR NEW.policy_ceiling_schema_version IS DISTINCT FROM
      OLD.policy_ceiling_schema_version
    OR NEW.policy_ceiling_rules IS DISTINCT FROM OLD.policy_ceiling_rules
    OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.replaces_credential_id IS DISTINCT FROM OLD.replaces_credential_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'Credential identity and authority are immutable; rotate by inserting a replacement'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.last_used_at IS NOT NULL
    AND (
      NEW.last_used_at IS NULL
      OR NEW.last_used_at < OLD.last_used_at
    ) THEN
    RAISE EXCEPTION
      'Credential last-used time is monotonic'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.revoked_at IS NOT NULL
    AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION
      'Credential revocation is irreversible and its time is immutable'
      USING ERRCODE = '22023';
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION platform.prepare_credential_update() FROM PUBLIC;

CREATE FUNCTION platform.validate_agent_policy_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  latest_version bigint;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'agent_policies'
    OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Agent policy insert validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  -- Serialize every policy head, including inserts attempted outside the
  -- application service, on the owning Agent row.
  PERFORM 1
  FROM platform.agents AS agent
  WHERE agent.id = NEW.agent_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agent policy subject does not exist'
      USING ERRCODE = '23503';
  END IF;

  IF NOT NEW.is_active THEN
    RAISE EXCEPTION 'A new Agent policy version must be active'
      USING ERRCODE = '23514';
  END IF;

  IF NOT platform.agent_policy_rules_are_valid(
    NEW.tier,
    NEW.defaults_version,
    NEW.policy_schema_version,
    NEW.rules
  ) THEN
    RAISE EXCEPTION 'Agent policy rules do not match the pinned schema'
      USING ERRCODE = '23514',
            CONSTRAINT = 'agent_policies_rules_valid';
  END IF;

  SELECT max(policy.version)
  INTO latest_version
  FROM platform.agent_policies AS policy
  WHERE policy.agent_id = NEW.agent_id;

  IF latest_version IS NULL THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'The first Agent policy version must be 1'
        USING ERRCODE = '23514';
    END IF;
  ELSIF latest_version = 9223372036854775807
    OR NEW.version <> latest_version + 1 THEN
    RAISE EXCEPTION 'Agent policy versions must be strictly sequential'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_policies_validate_insert
BEFORE INSERT ON platform.agent_policies
FOR EACH ROW
EXECUTE FUNCTION platform.validate_agent_policy_insert();

REVOKE ALL ON FUNCTION platform.validate_agent_policy_insert() FROM PUBLIC;
