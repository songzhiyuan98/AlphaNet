SET LOCAL search_path = pg_catalog;

-- Better Auth OAuth Provider 1.7 binds each Grant, Consent, Refresh Token, and
-- Access Token to the RFC 8707 resource indicator used during authorization.
-- AlphaNet has one immutable MCP Resource per environment, so every Provider
-- authority row must carry exactly the matching Grant resource.
ALTER TABLE auth.oauth_clients
  ADD COLUMN jwks text,
  ADD COLUMN "jwksUri" text;

ALTER TABLE auth.oauth_refresh_tokens
  ADD COLUMN resources jsonb;

ALTER TABLE auth.oauth_access_tokens
  ADD COLUMN resources jsonb;

ALTER TABLE auth.oauth_consents
  ADD COLUMN resources jsonb;

UPDATE auth.oauth_refresh_tokens AS refresh_token
SET resources = pg_catalog.jsonb_build_array(oauth_grant.resource)
FROM platform.oauth_grants AS oauth_grant
WHERE oauth_grant.id::text = refresh_token.reference_id;

UPDATE auth.oauth_access_tokens AS access_token
SET resources = pg_catalog.jsonb_build_array(oauth_grant.resource)
FROM platform.oauth_grants AS oauth_grant
WHERE oauth_grant.id::text = access_token.reference_id;

UPDATE auth.oauth_consents AS provider_consent
SET resources = pg_catalog.jsonb_build_array(oauth_grant.resource)
FROM platform.oauth_grants AS oauth_grant
WHERE oauth_grant.id::text = provider_consent.reference_id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM auth.oauth_refresh_tokens
    WHERE resources IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM auth.oauth_access_tokens
    WHERE resources IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM auth.oauth_consents
    WHERE resources IS NULL
  ) THEN
    RAISE EXCEPTION
      'Existing OAuth Provider authority cannot be bound to its Grant resource'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER TABLE auth.oauth_refresh_tokens
  ALTER COLUMN resources SET NOT NULL,
  ADD CONSTRAINT oauth_refresh_tokens_single_resource
    CHECK (
      pg_catalog.jsonb_typeof(resources) = 'array'
      AND pg_catalog.jsonb_array_length(resources) = 1
      AND pg_catalog.jsonb_typeof(resources -> 0) = 'string'
    );

ALTER TABLE auth.oauth_access_tokens
  ALTER COLUMN resources SET NOT NULL,
  ADD CONSTRAINT oauth_access_tokens_single_resource
    CHECK (
      pg_catalog.jsonb_typeof(resources) = 'array'
      AND pg_catalog.jsonb_array_length(resources) = 1
      AND pg_catalog.jsonb_typeof(resources -> 0) = 'string'
    );

ALTER TABLE auth.oauth_consents
  ALTER COLUMN resources SET NOT NULL,
  ADD CONSTRAINT oauth_consents_single_resource
    CHECK (
      pg_catalog.jsonb_typeof(resources) = 'array'
      AND pg_catalog.jsonb_array_length(resources) = 1
      AND pg_catalog.jsonb_typeof(resources -> 0) = 'string'
    );

ALTER TABLE auth.oauth_clients
  ADD CONSTRAINT oauth_clients_public_key_auth_disabled
    CHECK (jwks IS NULL AND "jwksUri" IS NULL);

COMMENT ON COLUMN auth.oauth_clients.jwks IS
  'Unused by AlphaNet public PKCE clients; asymmetric client authentication remains disabled.';

COMMENT ON COLUMN auth.oauth_clients."jwksUri" IS
  'Unused by AlphaNet public PKCE clients; remote client JWKS discovery remains disabled.';

COMMENT ON COLUMN auth.oauth_refresh_tokens.resources IS
  'Single RFC 8707 Resource bound to the matching AlphaNet OAuth Grant.';

COMMENT ON COLUMN auth.oauth_access_tokens.resources IS
  'Single RFC 8707 Resource bound to the matching AlphaNet OAuth Grant.';

COMMENT ON COLUMN auth.oauth_consents.resources IS
  'Single RFC 8707 Resource bound to the matching AlphaNet OAuth Grant.';

COMMENT ON TABLE auth.oauth_clients IS
  'Pre-registered OAuth 2.1 clients used by Better Auth OAuth Provider 1.7.0-beta.4. Anonymous and dynamic registration remain disabled in runtime configuration.';

CREATE OR REPLACE FUNCTION platform.validate_oauth_provider_grant_reference()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  grant_uuid uuid;
  grant_found boolean;
  grant_record record;
  provider_resource text;
  provider_scopes text[];
  expected_scopes text[];
  authority_expires_at timestamptz;
BEGIN
  IF TG_TABLE_SCHEMA <> 'auth'
    OR TG_TABLE_NAME NOT IN (
      'oauth_consents',
      'oauth_refresh_tokens',
      'oauth_access_tokens'
    )
    OR TG_OP NOT IN ('INSERT', 'UPDATE') THEN
    RAISE EXCEPTION 'OAuth Provider Grant validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.reference_id IS NULL THEN
    RAISE EXCEPTION 'Agent OAuth rows require a Grant reference'
      USING ERRCODE = '23514';
  END IF;

  BEGIN
    grant_uuid := NEW.reference_id::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'OAuth Provider Grant reference is invalid'
      USING ERRCODE = '23514';
  END;

  IF pg_catalog.jsonb_typeof(NEW.resources) IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_array_length(NEW.resources) <> 1
    OR pg_catalog.jsonb_typeof(NEW.resources -> 0) <> 'string' THEN
    RAISE EXCEPTION 'OAuth Provider row requires one Resource'
      USING ERRCODE = '23514';
  END IF;

  provider_resource := NEW.resources ->> 0;

  SELECT
    oauth_grant.auth_user_id,
    oauth_grant.oauth_client_id,
    oauth_grant.resource,
    oauth_grant.scopes,
    oauth_grant.offline_access,
    oauth_grant.status,
    oauth_grant.expires_at,
    credential.revoked_at AS credential_revoked_at,
    credential.expires_at AS credential_expires_at
  INTO grant_record
  FROM platform.oauth_grants AS oauth_grant
  INNER JOIN platform.credentials AS credential
    ON credential.id = oauth_grant.credential_id
   AND credential.owner_id = oauth_grant.owner_id
   AND credential.agent_id = oauth_grant.agent_id
  WHERE oauth_grant.id = grant_uuid
  FOR SHARE OF oauth_grant, credential;

  grant_found := FOUND;

  SELECT array_agg(member.value #>> '{}' ORDER BY member.value #>> '{}')
  INTO provider_scopes
  FROM pg_catalog.jsonb_array_elements(NEW.scopes) AS member(value);

  SELECT array_agg(scope ORDER BY scope)
  INTO expected_scopes
  FROM pg_catalog.unnest(
    CASE
      WHEN grant_record.offline_access
        THEN grant_record.scopes || 'offline_access'::text
      ELSE grant_record.scopes
    END
  ) AS value(scope);

  IF NOT grant_found
    OR grant_record.auth_user_id IS DISTINCT FROM NEW.user_id
    OR grant_record.oauth_client_id IS DISTINCT FROM NEW.client_id
    OR grant_record.resource IS DISTINCT FROM provider_resource
    OR provider_scopes IS DISTINCT FROM expected_scopes
    OR grant_record.status NOT IN ('pending', 'active')
    OR grant_record.expires_at <= statement_timestamp()
    OR grant_record.credential_revoked_at IS NOT NULL
    OR grant_record.credential_expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'OAuth Provider row does not match current Grant authority'
      USING ERRCODE = '23514';
  END IF;

  IF TG_TABLE_NAME IN ('oauth_refresh_tokens', 'oauth_access_tokens')
    AND grant_record.status <> 'active' THEN
    RAISE EXCEPTION 'OAuth tokens require an active Grant'
      USING ERRCODE = '23514';
  END IF;

  IF TG_TABLE_NAME IN ('oauth_refresh_tokens', 'oauth_access_tokens') THEN
    IF NEW.created_at IS NULL OR NEW.expires_at IS NULL THEN
      RAISE EXCEPTION 'OAuth tokens require explicit creation and expiry times'
        USING ERRCODE = '23514';
    END IF;

    authority_expires_at := least(
      grant_record.expires_at,
      grant_record.credential_expires_at
    );
    NEW.expires_at := least(
      NEW.expires_at,
      authority_expires_at
    );

    IF NEW.expires_at <= NEW.created_at
      OR NEW.expires_at <= statement_timestamp() THEN
      RAISE EXCEPTION 'OAuth token authority has reached absolute expiry'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER oauth_consents_validate_grant_reference
  ON auth.oauth_consents;

CREATE TRIGGER oauth_consents_validate_grant_reference
BEFORE INSERT OR UPDATE OF client_id, user_id, reference_id, resources, scopes
ON auth.oauth_consents
FOR EACH ROW
EXECUTE FUNCTION platform.validate_oauth_provider_grant_reference();

DROP TRIGGER oauth_refresh_tokens_validate_grant_reference
  ON auth.oauth_refresh_tokens;

CREATE TRIGGER oauth_refresh_tokens_validate_grant_reference
BEFORE INSERT OR UPDATE OF client_id, user_id, reference_id, resources, scopes
ON auth.oauth_refresh_tokens
FOR EACH ROW
EXECUTE FUNCTION platform.validate_oauth_provider_grant_reference();

DROP TRIGGER oauth_access_tokens_validate_grant_reference
  ON auth.oauth_access_tokens;

CREATE TRIGGER oauth_access_tokens_validate_grant_reference
BEFORE INSERT OR UPDATE OF client_id, user_id, reference_id, resources, scopes
ON auth.oauth_access_tokens
FOR EACH ROW
EXECUTE FUNCTION platform.validate_oauth_provider_grant_reference();

REVOKE ALL ON FUNCTION platform.validate_oauth_provider_grant_reference()
  FROM PUBLIC;
