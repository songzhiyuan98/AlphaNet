SET LOCAL search_path = pg_catalog;

-- Better Auth leaves several OAuth-client security fields nullable. AlphaNet
-- admits only explicitly configured, pre-registered OAuth 2.1 clients, so an
-- incomplete legacy row must fail closed before the columns become NOT NULL.
LOCK TABLE auth.oauth_clients IN ACCESS EXCLUSIVE MODE;

UPDATE auth.oauth_clients AS client
SET disabled = true,
    updated_at = greatest(
      clock_timestamp(),
      coalesce(client.updated_at, client.created_at, clock_timestamp())
    )
WHERE client.disabled IS DISTINCT FROM true
  AND (
    client.disabled IS DISTINCT FROM false
    OR client.skip_consent IS DISTINCT FROM false
    OR client.require_pkce IS DISTINCT FROM true
    OR client.token_endpoint_auth_method IS DISTINCT FROM 'none'
    OR client.public IS DISTINCT FROM true
    OR client.client_secret IS NOT NULL
    OR platform.oauth_provider_scopes_are_valid(client.scopes)
      IS DISTINCT FROM true
    OR platform.oauth_redirect_uris_are_valid(client.redirect_uris)
      IS DISTINCT FROM true
    OR CASE
      WHEN jsonb_typeof(client.grant_types) = 'array' THEN
        NOT (client.grant_types ? 'authorization_code')
        OR (
          coalesce(client.scopes ? 'offline_access', false)
          AND NOT (client.grant_types ? 'refresh_token')
        )
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(client.grant_types) AS grant_type(value)
          WHERE jsonb_typeof(grant_type.value) <> 'string'
            OR length(btrim(grant_type.value #>> '{}')) = 0
        )
      ELSE true
    END
  );

-- Structurally valid placeholders permit the NOT NULL conversion without
-- granting authority: every repaired row was disabled above. Scopes remain
-- intentionally default-less so future clients must declare them explicitly.
UPDATE auth.oauth_clients AS client
SET disabled = coalesce(client.disabled, true),
    skip_consent = coalesce(client.skip_consent, false),
    require_pkce = coalesce(client.require_pkce, true),
    scopes = coalesce(client.scopes, '["research:read"]'::jsonb),
    grant_types = coalesce(client.grant_types, '[]'::jsonb),
    updated_at = greatest(
      clock_timestamp(),
      coalesce(client.updated_at, client.created_at, clock_timestamp())
    )
WHERE client.disabled IS NULL
   OR client.skip_consent IS NULL
   OR client.require_pkce IS NULL
   OR client.scopes IS NULL
   OR client.grant_types IS NULL;

ALTER TABLE auth.oauth_clients
  ALTER COLUMN disabled SET DEFAULT true,
  ALTER COLUMN disabled SET NOT NULL,
  ALTER COLUMN skip_consent SET DEFAULT false,
  ALTER COLUMN skip_consent SET NOT NULL,
  ALTER COLUMN require_pkce SET DEFAULT true,
  ALTER COLUMN require_pkce SET NOT NULL,
  ALTER COLUMN scopes SET NOT NULL,
  ALTER COLUMN grant_types SET DEFAULT '[]'::jsonb,
  ALTER COLUMN grant_types SET NOT NULL;

COMMENT ON COLUMN auth.oauth_clients.disabled IS
  'Fail-closed client gate. Omitted values default to disabled and enabling a client requires a complete reviewed OAuth configuration.';

COMMENT ON COLUMN auth.oauth_clients.skip_consent IS
  'AlphaNet never bypasses explicit Owner consent; this column is always false.';

COMMENT ON COLUMN auth.oauth_clients.require_pkce IS
  'AlphaNet authorization-code clients always require PKCE S256; this column is always true.';

CREATE OR REPLACE FUNCTION platform.validate_oauth_authorization_request_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  client_record record;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'oauth_authorization_requests'
    OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'OAuth Authorization Request validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.status IS DISTINCT FROM 'pending'
    OR NEW.owner_id IS NOT NULL
    OR NEW.agent_id IS NOT NULL
    OR NEW.owner_session_id IS NOT NULL
    OR NEW.grant_id IS NOT NULL THEN
    RAISE EXCEPTION 'A new OAuth Authorization Request must start unselected'
      USING ERRCODE = '23514';
  END IF;

  SELECT
    client.disabled,
    client.skip_consent,
    client.require_pkce,
    client.token_endpoint_auth_method,
    client.public AS client_public,
    client.client_secret,
    client.scopes,
    client.redirect_uris,
    client.grant_types
  INTO client_record
  FROM auth.oauth_clients AS client
  WHERE client.client_id = NEW.oauth_client_id
  FOR SHARE;

  IF NOT FOUND
    OR client_record.disabled IS DISTINCT FROM false
    OR client_record.skip_consent IS DISTINCT FROM false
    OR client_record.require_pkce IS DISTINCT FROM true
    OR client_record.token_endpoint_auth_method IS DISTINCT FROM 'none'
    OR client_record.client_public IS DISTINCT FROM true
    OR client_record.client_secret IS NOT NULL
    OR jsonb_typeof(client_record.grant_types) IS DISTINCT FROM 'array'
    OR NOT (client_record.grant_types ? 'authorization_code')
    OR (
      'offline_access' = ANY(NEW.requested_scopes)
      AND NOT (client_record.grant_types ? 'refresh_token')
    )
    OR platform.oauth_redirect_uris_are_valid(client_record.redirect_uris)
      IS DISTINCT FROM true
    OR coalesce(client_record.redirect_uris ? NEW.redirect_uri, false)
      IS DISTINCT FROM true
    OR client_record.scopes IS NULL
    OR EXISTS (
      SELECT 1
      FROM unnest(NEW.requested_scopes) AS requested(scope)
      WHERE NOT (client_record.scopes ? requested.scope)
    ) THEN
    RAISE EXCEPTION
      'OAuth Authorization Request does not match an enabled pre-registered client'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION platform.validate_oauth_authorization_request_insert()
  FROM PUBLIC;

-- Grant creation and activation are separate from Authorization Request
-- admission. Revalidate the current client at both boundaries so a client
-- cannot become confidential, drop PKCE, or lose refresh authority after the
-- request was accepted. The SHARE lock serializes those checks with client
-- reconfiguration.
CREATE OR REPLACE FUNCTION platform.validate_oauth_grant_client_authority()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  client_record record;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'oauth_grants'
    OR TG_OP NOT IN ('INSERT', 'UPDATE') THEN
    RAISE EXCEPTION 'OAuth Grant client validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.status <> 'active' THEN
      RETURN NEW;
    END IF;
  ELSIF NEW.status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'A new OAuth Grant must start pending'
      USING ERRCODE = '23514';
  END IF;

  SELECT
    client.disabled,
    client.skip_consent,
    client.require_pkce,
    client.token_endpoint_auth_method,
    client.public AS client_public,
    client.client_secret,
    client.grant_types
  INTO client_record
  FROM auth.oauth_clients AS client
  WHERE client.client_id = NEW.oauth_client_id
  FOR SHARE;

  IF NOT FOUND
    OR client_record.disabled IS DISTINCT FROM false
    OR client_record.skip_consent IS DISTINCT FROM false
    OR client_record.require_pkce IS DISTINCT FROM true
    OR client_record.token_endpoint_auth_method IS DISTINCT FROM 'none'
    OR client_record.client_public IS DISTINCT FROM true
    OR client_record.client_secret IS NOT NULL
    OR jsonb_typeof(client_record.grant_types) IS DISTINCT FROM 'array'
    OR NOT (client_record.grant_types ? 'authorization_code')
    OR (
      NEW.offline_access
      AND NOT (client_record.grant_types ? 'refresh_token')
    ) THEN
    RAISE EXCEPTION 'OAuth Grant client authority is unavailable'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER oauth_grants_validate_client_authority
BEFORE INSERT OR UPDATE OF status ON platform.oauth_grants
FOR EACH ROW
EXECUTE FUNCTION platform.validate_oauth_grant_client_authority();

REVOKE ALL ON FUNCTION platform.validate_oauth_grant_client_authority()
  FROM PUBLIC;

CREATE OR REPLACE FUNCTION platform.prepare_oauth_authorization_request_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  grant_record record;
  session_user_id uuid;
  owner_auth_user_id uuid;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'oauth_authorization_requests'
    OR TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'OAuth Authorization Request guard invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.binding_digest IS DISTINCT FROM OLD.binding_digest
    OR NEW.oauth_client_id IS DISTINCT FROM OLD.oauth_client_id
    OR NEW.resource IS DISTINCT FROM OLD.resource
    OR NEW.requested_scopes IS DISTINCT FROM OLD.requested_scopes
    OR NEW.redirect_uri IS DISTINCT FROM OLD.redirect_uri
    OR NEW.code_challenge IS DISTINCT FROM OLD.code_challenge
    OR NEW.code_challenge_method IS DISTINCT FROM OLD.code_challenge_method
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'OAuth Authorization Request binding is immutable'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.status IN ('consumed', 'denied', 'expired') THEN
    RAISE EXCEPTION 'A terminal OAuth Authorization Request is immutable'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.owner_id IS NOT NULL
    AND (
      NEW.owner_id IS DISTINCT FROM OLD.owner_id
      OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
      OR NEW.owner_session_id IS DISTINCT FROM OLD.owner_session_id
      OR NEW.selected_at IS DISTINCT FROM OLD.selected_at
    ) THEN
    RAISE EXCEPTION 'OAuth Authorization Request selection is immutable'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.owner_id IS NULL AND NEW.owner_id IS NOT NULL THEN
    IF OLD.status <> 'pending' OR NEW.status <> 'selected' THEN
      RAISE EXCEPTION 'OAuth Agent selection requires pending to selected'
        USING ERRCODE = '23514';
    END IF;

    IF OLD.expires_at <= statement_timestamp() THEN
      RAISE EXCEPTION 'An expired OAuth Authorization Request cannot select an Agent'
        USING ERRCODE = '23514';
    END IF;

    NEW.selected_at := coalesce(NEW.selected_at, statement_timestamp());

    -- Match the application lock contract: Owner first, then the live Owner
    -- session/auth user, then the Agent lifecycle rows. The SHARE locks make
    -- session logout and email-verification changes serialize with selection;
    -- a waiter that observes their committed change fails this validation.
    SELECT owner.auth_user_id
    INTO owner_auth_user_id
    FROM platform.owners AS owner
    WHERE owner.id = NEW.owner_id
      AND owner.status = 'active'
      AND owner.email_verified_at IS NOT NULL
      AND owner.deleted_at IS NULL
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'OAuth Agent selection requires the owning active session'
        USING ERRCODE = '42501';
    END IF;

    SELECT session.user_id
    INTO session_user_id
    FROM auth.sessions AS session
    INNER JOIN auth.users AS auth_user
      ON auth_user.id = session.user_id
     AND auth_user.email_verified IS TRUE
    WHERE session.id = NEW.owner_session_id
      AND session.expires_at > statement_timestamp()
    FOR SHARE OF session, auth_user;

    IF session_user_id IS NULL
      OR owner_auth_user_id IS DISTINCT FROM session_user_id THEN
      RAISE EXCEPTION 'OAuth Agent selection requires the owning active session'
        USING ERRCODE = '42501';
    END IF;

    PERFORM 1
    FROM platform.agents AS agent
    INNER JOIN platform.actors AS actor
      ON actor.id = agent.actor_id
     AND actor.owner_id = NEW.owner_id
     AND actor.kind = 'agent'
     AND actor.status = 'active'
     AND actor.deleted_at IS NULL
    WHERE agent.id = NEW.agent_id
      AND agent.owner_id = NEW.owner_id
      AND agent.status = 'active'
      AND agent.deleted_at IS NULL
    FOR SHARE OF agent, actor;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'OAuth Agent selection requires the owning active session'
        USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status
    AND NOT (
      (OLD.status = 'pending' AND NEW.status IN ('denied', 'expired'))
      OR (
        OLD.status = 'selected'
        AND NEW.status IN ('consumed', 'denied', 'expired')
      )
    ) THEN
    RAISE EXCEPTION 'Illegal OAuth Authorization Request status transition'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'consumed'
    AND OLD.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'An expired OAuth Authorization Request cannot be consumed'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.grant_id IS DISTINCT FROM OLD.grant_id THEN
    IF OLD.grant_id IS NOT NULL OR NEW.grant_id IS NULL THEN
      RAISE EXCEPTION 'OAuth Authorization Request Grant binding is one-shot'
        USING ERRCODE = '22023';
    END IF;

    SELECT
      oauth_grant.owner_id,
      oauth_grant.agent_id,
      oauth_grant.authorization_request_id,
      oauth_grant.oauth_client_id,
      oauth_grant.resource,
      oauth_grant.scopes,
      oauth_grant.offline_access
    INTO grant_record
    FROM platform.oauth_grants AS oauth_grant
    WHERE oauth_grant.id = NEW.grant_id
    FOR SHARE;

    IF NOT FOUND
      OR grant_record.owner_id IS DISTINCT FROM NEW.owner_id
      OR grant_record.agent_id IS DISTINCT FROM NEW.agent_id
      OR grant_record.authorization_request_id IS DISTINCT FROM NEW.id
      OR grant_record.oauth_client_id IS DISTINCT FROM NEW.oauth_client_id
      OR grant_record.resource IS DISTINCT FROM NEW.resource
      OR NOT platform.oauth_text_arrays_are_same_set(
        grant_record.scopes,
        array_remove(NEW.requested_scopes, 'offline_access')
      )
      OR grant_record.offline_access IS DISTINCT FROM
        ('offline_access' = ANY(NEW.requested_scopes)) THEN
      RAISE EXCEPTION 'OAuth Authorization Request Grant does not match binding'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status = 'consumed' THEN
    NEW.consumed_at := coalesce(NEW.consumed_at, statement_timestamp());
    NEW.terminal_at := coalesce(NEW.terminal_at, NEW.consumed_at);
  ELSIF NEW.status IN ('denied', 'expired') THEN
    NEW.terminal_at := coalesce(NEW.terminal_at, statement_timestamp());
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION platform.prepare_oauth_authorization_request_update()
  FROM PUBLIC;

-- Provider timestamps may be derived from an application clock up to five
-- seconds ahead of PostgreSQL. Normalize revocation bookkeeping to the frozen
-- JTI event clock so a legitimate revoke cannot violate event ordering.
CREATE OR REPLACE FUNCTION platform.prepare_oauth_access_token_jti_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'oauth_access_token_jtis'
    OR TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'OAuth access-token jti guard invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.jti_digest IS DISTINCT FROM OLD.jti_digest
    OR NEW.grant_id IS DISTINCT FROM OLD.grant_id
    OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
    OR NEW.grant_epoch IS DISTINCT FROM OLD.grant_epoch
    OR NEW.oauth_client_id IS DISTINCT FROM OLD.oauth_client_id
    OR NEW.resource IS DISTINCT FROM OLD.resource
    OR NEW.scopes IS DISTINCT FROM OLD.scopes
    OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'OAuth access-token jti authority is immutable'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.status = 'revoked' THEN
    RAISE EXCEPTION 'OAuth access-token jti revocation is irreversible'
      USING ERRCODE = '22023';
  END IF;

  IF NEW.status <> 'revoked'
    OR NEW.revoked_at IS NULL
    OR NEW.revocation_reason_code IS NULL THEN
    RAISE EXCEPTION 'OAuth access-token jti update must revoke the token'
      USING ERRCODE = '23514';
  END IF;

  NEW.revoked_at := greatest(NEW.revoked_at, OLD.issued_at);
  NEW.updated_at := greatest(
    clock_timestamp(),
    OLD.created_at,
    NEW.revoked_at
  );
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION platform.prepare_oauth_access_token_jti_update()
  FROM PUBLIC;
