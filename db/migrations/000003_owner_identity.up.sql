SET LOCAL search_path = pg_catalog;

CREATE TABLE platform.registration_controls (
  id boolean PRIMARY KEY DEFAULT true,
  version bigint NOT NULL DEFAULT 1,
  mode text NOT NULL DEFAULT 'open',
  pause_reason_code text,
  paused_at timestamptz,
  resume_condition text,
  active_agent_count bigint NOT NULL DEFAULT 0,
  active_agent_operating_target bigint NOT NULL DEFAULT 5000,
  active_agent_hard_limit bigint NOT NULL DEFAULT 10000,
  updated_by_admin_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT registration_controls_singleton
    CHECK (id),
  CONSTRAINT registration_controls_version_positive
    CHECK (version > 0),
  CONSTRAINT registration_controls_mode
    CHECK (mode IN ('open', 'paused')),
  CONSTRAINT registration_controls_pause_reason_format
    CHECK (
      pause_reason_code IS NULL
      OR pause_reason_code ~ '^[a-z0-9][a-z0-9_.-]{0,119}$'
    ),
  CONSTRAINT registration_controls_pause_state
    CHECK (
      (
        mode = 'open'
        AND pause_reason_code IS NULL
        AND paused_at IS NULL
        AND resume_condition IS NULL
      )
      OR (mode = 'paused' AND pause_reason_code IS NOT NULL AND paused_at IS NOT NULL)
    ),
  CONSTRAINT registration_controls_resume_condition_size
    CHECK (
      resume_condition IS NULL
      OR length(btrim(resume_condition)) BETWEEN 1 AND 1000
    ),
  CONSTRAINT registration_controls_capacity_nonnegative
    CHECK (active_agent_count >= 0),
  CONSTRAINT registration_controls_capacity_order
    CHECK (
      active_agent_operating_target > 0
      AND active_agent_hard_limit >= active_agent_operating_target
      AND active_agent_count <= active_agent_hard_limit
    ),
  CONSTRAINT registration_controls_updated_after_created
    CHECK (updated_at >= created_at)
);

COMMENT ON TABLE platform.registration_controls IS
  'Singleton, versioned registration and active-Agent capacity control. It is not an invite list or waitlist.';

INSERT INTO platform.registration_controls (id)
VALUES (true);

CREATE TABLE platform.owners (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  auth_user_id uuid NOT NULL
    REFERENCES auth.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  email public.citext NOT NULL,
  email_verified_at timestamptz,
  status text NOT NULL DEFAULT 'pending_verification',
  restriction_reason_code text,
  restricted_at timestamptz,
  suspended_at timestamptz,
  locale text NOT NULL DEFAULT 'en',
  timezone text NOT NULL DEFAULT 'UTC',
  base_active_agent_limit integer NOT NULL DEFAULT 5,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  CONSTRAINT owners_auth_user_unique
    UNIQUE (auth_user_id),
  CONSTRAINT owners_email_not_blank
    CHECK (length(btrim(email::text)) BETWEEN 3 AND 320),
  CONSTRAINT owners_status
    CHECK (
      status IN (
        'pending_verification',
        'active',
        'restricted',
        'suspended',
        'closed'
      )
    ),
  CONSTRAINT owners_email_verification_state
    CHECK (
      (status <> 'active' OR email_verified_at IS NOT NULL)
      AND (status <> 'pending_verification' OR email_verified_at IS NULL)
    ),
  CONSTRAINT owners_restriction_reason_format
    CHECK (
      restriction_reason_code IS NULL
      OR restriction_reason_code ~ '^[a-z0-9][a-z0-9_.-]{0,119}$'
    ),
  CONSTRAINT owners_restricted_state_complete
    CHECK (
      status <> 'restricted'
      OR (restriction_reason_code IS NOT NULL AND restricted_at IS NOT NULL)
    ),
  CONSTRAINT owners_suspended_state_complete
    CHECK (
      status <> 'suspended'
      OR (restriction_reason_code IS NOT NULL AND suspended_at IS NOT NULL)
    ),
  CONSTRAINT owners_locale_format
    CHECK (
      locale ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'
      AND length(locale) <= 35
    ),
  CONSTRAINT owners_timezone_size
    CHECK (length(btrim(timezone)) BETWEEN 1 AND 100),
  CONSTRAINT owners_base_active_agent_limit
    CHECK (base_active_agent_limit BETWEEN 1 AND 1000),
  CONSTRAINT owners_email_verified_after_created
    CHECK (email_verified_at IS NULL OR email_verified_at >= created_at),
  CONSTRAINT owners_restricted_after_created
    CHECK (restricted_at IS NULL OR restricted_at >= created_at),
  CONSTRAINT owners_suspended_after_created
    CHECK (suspended_at IS NULL OR suspended_at >= created_at),
  CONSTRAINT owners_updated_after_created
    CHECK (updated_at >= created_at),
  CONSTRAINT owners_deleted_after_created
    CHECK (deleted_at IS NULL OR deleted_at >= created_at)
);

CREATE UNIQUE INDEX owners_email_active_unique
  ON platform.owners (email)
  WHERE deleted_at IS NULL;

CREATE INDEX owners_status_idx
  ON platform.owners (status, id)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE platform.owners IS
  'Stable private mapping from a Better Auth human identity to AlphaNet ownership and governance state.';

COMMENT ON COLUMN platform.owners.email IS
  'Case-insensitive projection of auth.users.email. auth.users remains the authentication source of truth.';

COMMENT ON COLUMN platform.owners.email_verified_at IS
  'Platform authorization gate synchronized from auth.users.email_verified; it is not a trust badge.';

CREATE FUNCTION platform.prepare_registration_control_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'registration_controls'
    OR TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION
      'registration control update trigger invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'registration control identity and creation time are immutable'
      USING ERRCODE = '22023';
  END IF;

  NEW.version := OLD.version + 1;
  NEW.updated_at := clock_timestamp();

  IF NEW.mode IS DISTINCT FROM OLD.mode THEN
    IF NEW.mode = 'paused' THEN
      NEW.paused_at := clock_timestamp();
    ELSE
      NEW.pause_reason_code := NULL;
      NEW.paused_at := NULL;
      NEW.resume_condition := NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER registration_controls_prepare_update
BEFORE UPDATE ON platform.registration_controls
FOR EACH ROW
EXECUTE FUNCTION platform.prepare_registration_control_update();

REVOKE ALL ON FUNCTION platform.prepare_registration_control_update() FROM PUBLIC;

CREATE FUNCTION platform.prevent_registration_control_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'registration_controls'
    OR TG_OP <> 'DELETE' THEN
    RAISE EXCEPTION
      'registration control delete trigger invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  RAISE EXCEPTION
    'the registration control singleton cannot be deleted'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER registration_controls_prevent_delete
BEFORE DELETE ON platform.registration_controls
FOR EACH ROW
EXECUTE FUNCTION platform.prevent_registration_control_delete();

REVOKE ALL ON FUNCTION platform.prevent_registration_control_delete() FROM PUBLIC;

CREATE FUNCTION platform.guard_auth_user_registration()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  registration_mode text;
BEGIN
  IF TG_TABLE_SCHEMA <> 'auth'
    OR TG_TABLE_NAME <> 'users'
    OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'registration guard trigger invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  SELECT controls.mode
  INTO registration_mode
  FROM platform.registration_controls AS controls
  WHERE controls.id = true
  FOR SHARE;

  IF registration_mode IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION
      'new Owner registration is temporarily paused'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER auth_users_registration_open
BEFORE INSERT ON auth.users
FOR EACH ROW
EXECUTE FUNCTION platform.guard_auth_user_registration();

REVOKE ALL ON FUNCTION platform.guard_auth_user_registration() FROM PUBLIC;

CREATE FUNCTION platform.finalize_credential_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'auth'
    OR TG_TABLE_NAME <> 'accounts'
    OR TG_OP NOT IN ('INSERT', 'UPDATE') THEN
    RAISE EXCEPTION
      'credential finalization trigger invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM auth.verifications
  WHERE value = NEW.user_id::text;

  -- Keep revocation in the credential write transaction. Better Auth repeats
  -- this deletion after its password-reset handler, but a process failure
  -- between those operations must never leave an old session authenticated.
  DELETE FROM auth.sessions
  WHERE user_id = NEW.user_id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER auth_accounts_finalize_credential_insert
AFTER INSERT ON auth.accounts
FOR EACH ROW
WHEN (NEW.provider_id = 'credential' AND NEW.password IS NOT NULL)
EXECUTE FUNCTION platform.finalize_credential_change();

CREATE TRIGGER auth_accounts_finalize_password_update
AFTER UPDATE OF password ON auth.accounts
FOR EACH ROW
WHEN (
  NEW.provider_id = 'credential'
  AND NEW.password IS NOT NULL
  AND OLD.password IS DISTINCT FROM NEW.password
)
EXECUTE FUNCTION platform.finalize_credential_change();

REVOKE ALL ON FUNCTION platform.finalize_credential_change() FROM PUBLIC;

CREATE FUNCTION platform.provision_owner_from_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  provisioned_at timestamptz := clock_timestamp();
BEGIN
  IF TG_TABLE_SCHEMA <> 'auth'
    OR TG_TABLE_NAME <> 'users'
    OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Owner provisioning trigger invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO platform.owners (
    auth_user_id,
    email,
    email_verified_at,
    status,
    created_at,
    updated_at
  )
  VALUES (
    NEW.id,
    NEW.email,
    CASE WHEN NEW.email_verified THEN provisioned_at ELSE NULL END,
    CASE WHEN NEW.email_verified THEN 'active' ELSE 'pending_verification' END,
    provisioned_at,
    provisioned_at
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER auth_users_provision_owner
AFTER INSERT ON auth.users
FOR EACH ROW
EXECUTE FUNCTION platform.provision_owner_from_auth_user();

REVOKE ALL ON FUNCTION platform.provision_owner_from_auth_user() FROM PUBLIC;

CREATE FUNCTION platform.sync_owner_from_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'auth'
    OR TG_TABLE_NAME <> 'users'
    OR TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION
      'Owner synchronization trigger invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  UPDATE platform.owners AS owner
  SET email = NEW.email,
      email_verified_at = CASE
        WHEN NOT NEW.email_verified THEN NULL
        WHEN NOT OLD.email_verified OR NEW.email IS DISTINCT FROM OLD.email
          THEN clock_timestamp()
        ELSE COALESCE(owner.email_verified_at, clock_timestamp())
      END,
      status = CASE
        WHEN owner.status IN ('restricted', 'suspended', 'closed')
          THEN owner.status
        WHEN NEW.email_verified
          THEN 'active'
        ELSE 'pending_verification'
      END,
      updated_at = clock_timestamp()
  WHERE owner.auth_user_id = NEW.id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'auth user is missing its Owner projection'
      USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER auth_users_sync_owner
AFTER UPDATE OF email, email_verified ON auth.users
FOR EACH ROW
WHEN (
  OLD.email IS DISTINCT FROM NEW.email
  OR OLD.email_verified IS DISTINCT FROM NEW.email_verified
)
EXECUTE FUNCTION platform.sync_owner_from_auth_user();

REVOKE ALL ON FUNCTION platform.sync_owner_from_auth_user() FROM PUBLIC;

CREATE FUNCTION platform.validate_owner_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  auth_email text;
  auth_email_verified boolean;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'owners'
    OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Owner insert validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  SELECT auth_user.email, auth_user.email_verified
  INTO auth_email, auth_email_verified
  FROM auth.users AS auth_user
  WHERE auth_user.id = NEW.auth_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Owner mapping references a missing auth user'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.email::text IS DISTINCT FROM auth_email
    OR (NEW.email_verified_at IS NOT NULL) IS DISTINCT FROM auth_email_verified THEN
    RAISE EXCEPTION
      'Owner email projection must match its auth user'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER owners_validate_insert
BEFORE INSERT ON platform.owners
FOR EACH ROW
EXECUTE FUNCTION platform.validate_owner_insert();

REVOKE ALL ON FUNCTION platform.validate_owner_insert() FROM PUBLIC;

CREATE FUNCTION platform.prepare_owner_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  auth_email text;
  auth_email_verified boolean;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'owners'
    OR TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION
      'Owner update trigger invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.auth_user_id IS DISTINCT FROM OLD.auth_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'Owner identity mapping and creation time are immutable'
      USING ERRCODE = '22023';
  END IF;

  SELECT auth_user.email, auth_user.email_verified
  INTO auth_email, auth_email_verified
  FROM auth.users AS auth_user
  WHERE auth_user.id = NEW.auth_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Owner mapping references a missing auth user'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.email::text IS DISTINCT FROM auth_email
    OR (NEW.email_verified_at IS NOT NULL) IS DISTINCT FROM auth_email_verified THEN
    RAISE EXCEPTION
      'Owner email projection must match its auth user'
      USING ERRCODE = '23514';
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER owners_prepare_update
BEFORE UPDATE ON platform.owners
FOR EACH ROW
EXECUTE FUNCTION platform.prepare_owner_update();

REVOKE ALL ON FUNCTION platform.prepare_owner_update() FROM PUBLIC;

CREATE FUNCTION platform.prevent_owner_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'owners'
    OR TG_OP <> 'DELETE' THEN
    RAISE EXCEPTION
      'Owner delete trigger invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  RAISE EXCEPTION
    'Owner identity projections cannot be hard deleted'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER owners_prevent_delete
BEFORE DELETE ON platform.owners
FOR EACH ROW
EXECUTE FUNCTION platform.prevent_owner_delete();

REVOKE ALL ON FUNCTION platform.prevent_owner_delete() FROM PUBLIC;
