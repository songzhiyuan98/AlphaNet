SET LOCAL search_path = pg_catalog;

-- Better Auth 1.6.23 OAuth Provider + JWT plugin schema. The table and
-- column mappings below are also used by packages/auth schema generation.
-- Client secrets use the Provider's SHA-256 base64url digest. Refresh and
-- opaque access tokens use AlphaNet's independently keyed HMAC-SHA-256
-- base64url digest. The JWK private key is encrypted by the pinned JWT plugin
-- before it reaches PostgreSQL.
CREATE TABLE auth.oauth_jwks (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  public_key text NOT NULL,
  private_key text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz,
  CONSTRAINT oauth_jwks_public_key_not_blank
    CHECK (length(btrim(public_key)) > 0),
  CONSTRAINT oauth_jwks_private_key_not_blank
    CHECK (length(btrim(private_key)) > 0),
  CONSTRAINT oauth_jwks_expiry_after_creation
    CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE TABLE auth.oauth_clients (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  client_id text NOT NULL UNIQUE,
  client_secret text,
  disabled boolean,
  skip_consent boolean,
  enable_end_session boolean,
  subject_type text,
  scopes jsonb,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz,
  updated_at timestamptz,
  name text,
  uri text,
  icon text,
  contacts jsonb,
  tos text,
  policy text,
  software_id text,
  software_version text,
  software_statement text,
  redirect_uris jsonb NOT NULL,
  post_logout_redirect_uris jsonb,
  token_endpoint_auth_method text,
  grant_types jsonb,
  response_types jsonb,
  public boolean,
  type text,
  require_pkce boolean,
  reference_id text,
  metadata jsonb,
  CONSTRAINT oauth_clients_id_not_blank
    CHECK (
      length(client_id) BETWEEN 1 AND 200
      AND client_id !~ '[[:space:][:cntrl:]]'
    ),
  CONSTRAINT oauth_clients_secret_is_digest
    CHECK (
      client_secret IS NULL
      OR client_secret ~ '^[A-Za-z0-9_-]{43}$'
    ),
  CONSTRAINT oauth_clients_consent_required
    CHECK (skip_consent IS DISTINCT FROM true),
  CONSTRAINT oauth_clients_pkce_not_disabled
    CHECK (require_pkce IS DISTINCT FROM false),
  CONSTRAINT oauth_clients_metadata_object
    CHECK (metadata IS NULL OR jsonb_typeof(metadata) = 'object'),
  CONSTRAINT oauth_clients_updated_after_created
    CHECK (
      created_at IS NULL
      OR updated_at IS NULL
      OR updated_at >= created_at
    )
);

CREATE TABLE auth.oauth_refresh_tokens (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  token text NOT NULL UNIQUE,
  client_id text NOT NULL
    REFERENCES auth.oauth_clients(client_id) ON DELETE CASCADE,
  session_id uuid REFERENCES auth.sessions(id) ON DELETE SET NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reference_id text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  revoked timestamptz,
  auth_time timestamptz,
  scopes jsonb NOT NULL,
  CONSTRAINT oauth_refresh_tokens_token_is_digest
    CHECK (token ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT oauth_refresh_tokens_reference_format
    CHECK (
      reference_id IS NULL
      OR reference_id ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
  CONSTRAINT oauth_refresh_tokens_expiry_after_creation
    CHECK (expires_at > created_at),
  CONSTRAINT oauth_refresh_tokens_revoked_after_creation
    CHECK (revoked IS NULL OR revoked >= created_at),
  CONSTRAINT oauth_refresh_tokens_auth_time_not_future
    CHECK (
      auth_time IS NULL
      OR auth_time < created_at + interval '1 second'
    )
);

CREATE TABLE auth.oauth_access_tokens (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  token text NOT NULL UNIQUE,
  client_id text NOT NULL
    REFERENCES auth.oauth_clients(client_id) ON DELETE CASCADE,
  session_id uuid REFERENCES auth.sessions(id) ON DELETE SET NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  reference_id text,
  refresh_id uuid
    REFERENCES auth.oauth_refresh_tokens(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  scopes jsonb NOT NULL,
  CONSTRAINT oauth_access_tokens_token_is_digest
    CHECK (token ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT oauth_access_tokens_reference_format
    CHECK (
      reference_id IS NULL
      OR reference_id ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
  CONSTRAINT oauth_access_tokens_expiry_after_creation
    CHECK (expires_at > created_at)
);

CREATE TABLE auth.oauth_consents (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  client_id text NOT NULL
    REFERENCES auth.oauth_clients(client_id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  reference_id text,
  scopes jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT oauth_consents_reference_format
    CHECK (
      reference_id IS NULL
      OR reference_id ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
  CONSTRAINT oauth_consents_updated_after_created
    CHECK (updated_at >= created_at)
);

CREATE INDEX oauth_clients_user_id_idx
  ON auth.oauth_clients (user_id);

CREATE INDEX oauth_refresh_tokens_client_id_idx
  ON auth.oauth_refresh_tokens (client_id);

CREATE INDEX oauth_refresh_tokens_session_id_idx
  ON auth.oauth_refresh_tokens (session_id);

CREATE INDEX oauth_refresh_tokens_user_id_idx
  ON auth.oauth_refresh_tokens (user_id);

CREATE INDEX oauth_access_tokens_client_id_idx
  ON auth.oauth_access_tokens (client_id);

CREATE INDEX oauth_access_tokens_session_id_idx
  ON auth.oauth_access_tokens (session_id);

CREATE INDEX oauth_access_tokens_user_id_idx
  ON auth.oauth_access_tokens (user_id);

CREATE INDEX oauth_access_tokens_refresh_id_idx
  ON auth.oauth_access_tokens (refresh_id);

CREATE INDEX oauth_consents_client_id_idx
  ON auth.oauth_consents (client_id);

CREATE INDEX oauth_consents_user_id_idx
  ON auth.oauth_consents (user_id);

CREATE INDEX oauth_jwks_expiry_idx
  ON auth.oauth_jwks (expires_at, created_at, id);

CREATE INDEX oauth_refresh_tokens_family_idx
  ON auth.oauth_refresh_tokens (
    client_id,
    user_id,
    reference_id,
    created_at DESC,
    id
  );

CREATE INDEX oauth_refresh_tokens_active_expiry_idx
  ON auth.oauth_refresh_tokens (expires_at, id)
  WHERE revoked IS NULL;

CREATE INDEX oauth_access_tokens_expiry_idx
  ON auth.oauth_access_tokens (expires_at, id);

CREATE UNIQUE INDEX oauth_consents_subject_unique
  ON auth.oauth_consents (client_id, user_id, reference_id)
  NULLS NOT DISTINCT;

COMMENT ON TABLE auth.oauth_clients IS
  'Pre-registered OAuth 2.1 clients used by Better Auth OAuth Provider 1.6.23. Anonymous and dynamic registration remain disabled in runtime configuration.';

COMMENT ON COLUMN auth.oauth_clients.client_secret IS
  'SHA-256 base64url digest. OAuth client secret plaintext is returned once and is never persisted.';

COMMENT ON TABLE auth.oauth_refresh_tokens IS
  'Canonical Better Auth refresh-token rotation rows. token is an AlphaNet keyed HMAC-SHA-256 base64url digest; reference_id is an AlphaNet OAuth Grant id.';

COMMENT ON TABLE auth.oauth_access_tokens IS
  'Canonical Better Auth opaque access-token rows. token is an AlphaNet keyed HMAC-SHA-256 base64url digest; MCP JWT identifiers and explicit revocation state live separately in platform.oauth_access_token_jtis.';

COMMENT ON COLUMN auth.oauth_jwks.private_key IS
  'Encrypted JWK private-key payload produced by the Better Auth JWT plugin. Plain JWK private material must never be stored.';

-- Both the Provider and AlphaNet domain boundary use closed, order-insensitive
-- scope sets. offline_access is a protocol scope and never becomes a
-- platform.credentials capability.
CREATE FUNCTION platform.oauth_requested_scopes_are_valid(candidate text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT candidate IS NOT NULL
    AND array_ndims(candidate) = 1
    AND cardinality(candidate) BETWEEN 1 AND 8
    AND array_position(candidate, NULL) IS NULL
    AND platform.text_array_has_unique_values(candidate)
    AND candidate <@ ARRAY[
      'research:read',
      'community:read',
      'notifications:read',
      'actions:read',
      'content:write',
      'reaction:write',
      'follow:write',
      'offline_access'
    ]::text[]
    AND candidate && ARRAY[
      'research:read',
      'community:read',
      'notifications:read',
      'actions:read',
      'content:write',
      'reaction:write',
      'follow:write'
    ]::text[];
$$;

CREATE FUNCTION platform.oauth_provider_scopes_are_valid(candidate jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
DECLARE
  normalized text[];
BEGIN
  IF candidate IS NULL OR jsonb_typeof(candidate) <> 'array' THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(candidate) AS member(value)
    WHERE jsonb_typeof(member.value) <> 'string'
  ) THEN
    RETURN false;
  END IF;

  SELECT coalesce(array_agg(member.value #>> '{}'), ARRAY[]::text[])
  INTO normalized
  FROM jsonb_array_elements(candidate) AS member(value);

  RETURN platform.oauth_requested_scopes_are_valid(normalized);
END;
$$;

CREATE FUNCTION platform.oauth_redirect_uris_are_valid(candidate jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
DECLARE
  uri text;
  uri_count integer;
  distinct_count integer;
BEGIN
  IF candidate IS NULL OR jsonb_typeof(candidate) <> 'array' THEN
    RETURN false;
  END IF;

  SELECT count(*)::integer,
         count(DISTINCT member.value #>> '{}')::integer
  INTO uri_count, distinct_count
  FROM jsonb_array_elements(candidate) AS member(value)
  WHERE jsonb_typeof(member.value) = 'string';

  IF uri_count NOT BETWEEN 1 AND 20
    OR distinct_count <> uri_count
    OR uri_count <> jsonb_array_length(candidate) THEN
    RETURN false;
  END IF;

  FOR uri IN
    SELECT member.value #>> '{}'
    FROM jsonb_array_elements(candidate) AS member(value)
  LOOP
    IF octet_length(convert_to(uri, 'UTF8')) NOT BETWEEN 1 AND 2048
      OR uri ~ '[[:space:][:cntrl:]]'
      OR uri ~ '#'
      OR (
        uri !~ '^https://[^/]+'
        AND uri !~ '^http://(localhost|127[.]0[.]0[.]1|\[::1\])([:/]|$)'
      ) THEN
      RETURN false;
    END IF;
  END LOOP;

  RETURN true;
END;
$$;

CREATE FUNCTION platform.oauth_resource_is_valid(candidate text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
DECLARE
  hostname text;
  hostname_label text;
  is_https boolean;
  parts text[];
  port_number integer;
  port_text text;
BEGIN
  IF candidate IS NULL
    OR length(candidate) NOT BETWEEN 1 AND 500
    OR candidate ~ '[[:space:][:cntrl:]]' THEN
    RETURN false;
  END IF;

  -- The whole input is matched so credentials, query, fragment, whitespace,
  -- alternate path serialization, and URL-parser normalization are rejected.
  -- DNS hosts are lowercase canonical ASCII; Unicode input must first use its
  -- canonical IDNA/punycode serialization.
  parts := regexp_match(
    candidate,
    '^https://([a-z0-9.-]+)(:([1-9][0-9]{0,4}))?/mcp$'
  );
  IF parts IS NOT NULL THEN
    is_https := true;
    hostname := parts[1];
    port_text := parts[3];

    -- Numeric URL hosts have several legacy parser representations. Reject all
    -- numeric-only forms instead of attempting to duplicate WHATWG IPv4
    -- normalization in PostgreSQL; the only admitted IP literal is HTTP
    -- 127.0.0.1 below.
    IF length(hostname) > 253 OR hostname ~ '^[0-9.]+$' THEN
      RETURN false;
    END IF;

    FOREACH hostname_label IN ARRAY string_to_array(hostname, '.')
    LOOP
      IF length(hostname_label) NOT BETWEEN 1 AND 63
        OR hostname_label !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' THEN
        RETURN false;
      END IF;
    END LOOP;
  ELSE
    parts := regexp_match(
      candidate,
      '^http://(localhost|127[.]0[.]0[.]1|\[::1\])(:([1-9][0-9]{0,4}))?/mcp$'
    );
    IF parts IS NULL THEN
      RETURN false;
    END IF;

    is_https := false;
    port_text := parts[3];
  END IF;

  IF port_text IS NOT NULL THEN
    port_number := port_text::integer;
    IF port_number > 65535
      OR (is_https AND port_number = 443)
      OR (NOT is_https AND port_number = 80) THEN
      RETURN false;
    END IF;
  END IF;

  RETURN true;
END;
$$;

CREATE FUNCTION platform.oauth_text_arrays_are_same_set(
  left_values text[],
  right_values text[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT left_values IS NOT NULL
    AND right_values IS NOT NULL
    AND left_values <@ right_values
    AND right_values <@ left_values;
$$;

REVOKE ALL ON FUNCTION platform.oauth_requested_scopes_are_valid(text[])
  FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.oauth_provider_scopes_are_valid(jsonb)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.oauth_redirect_uris_are_valid(jsonb)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.oauth_resource_is_valid(text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.oauth_text_arrays_are_same_set(text[], text[])
  FROM PUBLIC;

-- RFC 8707 audience binding is a platform invariant, not a caller choice.
-- The singleton deliberately starts empty so each environment must provision
-- its canonical MCP URL explicitly before public OAuth can be enabled. Once
-- configured, changing the resource requires a forward migration.
CREATE TABLE platform.oauth_resource_configuration (
  id boolean PRIMARY KEY DEFAULT true,
  resource text NOT NULL UNIQUE,
  configured_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT oauth_resource_configuration_singleton
    CHECK (id),
  CONSTRAINT oauth_resource_configuration_resource
    CHECK (platform.oauth_resource_is_valid(resource))
);

COMMENT ON TABLE platform.oauth_resource_configuration IS
  'Immutable singleton containing the one canonical RFC 8707 MCP resource accepted by AlphaNet. It is provisioned explicitly per environment and must end in the exact /mcp path.';

CREATE FUNCTION platform.prevent_oauth_resource_configuration_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'oauth_resource_configuration'
    OR TG_OP NOT IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION
      'OAuth resource configuration guard invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  RAISE EXCEPTION 'The canonical OAuth resource is immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER oauth_resource_configuration_prevent_mutation
BEFORE UPDATE OR DELETE ON platform.oauth_resource_configuration
FOR EACH ROW
EXECUTE FUNCTION platform.prevent_oauth_resource_configuration_mutation();

REVOKE ALL ON FUNCTION platform.prevent_oauth_resource_configuration_mutation()
  FROM PUBLIC;

ALTER TABLE auth.oauth_clients
  ADD CONSTRAINT oauth_clients_scopes_valid
    CHECK (
      scopes IS NULL
      OR platform.oauth_provider_scopes_are_valid(scopes)
    ),
  ADD CONSTRAINT oauth_clients_redirect_uris_valid
    CHECK (platform.oauth_redirect_uris_are_valid(redirect_uris)),
  ADD CONSTRAINT oauth_clients_post_logout_redirect_uris_valid
    CHECK (
      post_logout_redirect_uris IS NULL
      OR platform.oauth_redirect_uris_are_valid(post_logout_redirect_uris)
    );

ALTER TABLE auth.oauth_refresh_tokens
  ADD CONSTRAINT oauth_refresh_tokens_scopes_valid
    CHECK (platform.oauth_provider_scopes_are_valid(scopes));

ALTER TABLE auth.oauth_access_tokens
  ADD CONSTRAINT oauth_access_tokens_scopes_valid
    CHECK (platform.oauth_provider_scopes_are_valid(scopes));

ALTER TABLE auth.oauth_consents
  ADD CONSTRAINT oauth_consents_scopes_valid
    CHECK (platform.oauth_provider_scopes_are_valid(scopes));

-- This redundant key permits every Grant to bind the Better Auth user and the
-- AlphaNet Owner in a single declarative ownership edge.
ALTER TABLE platform.owners
  ADD CONSTRAINT owners_id_auth_user_unique
  UNIQUE (id, auth_user_id);

CREATE TABLE platform.oauth_authorization_requests (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  binding_digest bytea NOT NULL UNIQUE,
  oauth_client_id text NOT NULL
    REFERENCES auth.oauth_clients(client_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  resource text NOT NULL,
  requested_scopes text[] NOT NULL,
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL,
  code_challenge_method text NOT NULL DEFAULT 'S256',
  owner_id uuid,
  agent_id uuid,
  owner_session_id uuid,
  grant_id uuid,
  status text NOT NULL DEFAULT 'pending',
  selected_at timestamptz,
  consumed_at timestamptz,
  terminal_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT oauth_authorization_requests_id_owner_agent_unique
    UNIQUE (id, owner_id, agent_id),
  CONSTRAINT oauth_authorization_requests_agent_owner
    FOREIGN KEY (agent_id, owner_id)
    REFERENCES platform.agents(id, owner_id)
    MATCH FULL
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT oauth_authorization_requests_configured_resource
    FOREIGN KEY (resource)
    REFERENCES platform.oauth_resource_configuration(resource)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT oauth_authorization_requests_binding_digest
    CHECK (octet_length(binding_digest) = 32),
  CONSTRAINT oauth_authorization_requests_resource
    CHECK (platform.oauth_resource_is_valid(resource)),
  CONSTRAINT oauth_authorization_requests_scopes
    CHECK (platform.oauth_requested_scopes_are_valid(requested_scopes)),
  CONSTRAINT oauth_authorization_requests_redirect_uri
    CHECK (
      octet_length(convert_to(redirect_uri, 'UTF8')) BETWEEN 1 AND 2048
      AND redirect_uri !~ '[[:space:][:cntrl:]#]'
    ),
  CONSTRAINT oauth_authorization_requests_code_challenge
    CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT oauth_authorization_requests_pkce_s256
    CHECK (code_challenge_method = 'S256'),
  CONSTRAINT oauth_authorization_requests_status
    CHECK (status IN ('pending', 'selected', 'consumed', 'denied', 'expired')),
  CONSTRAINT oauth_authorization_requests_selection_shape
    CHECK (
      (
        owner_id IS NULL
        AND agent_id IS NULL
        AND owner_session_id IS NULL
        AND selected_at IS NULL
        AND status IN ('pending', 'denied', 'expired')
      )
      OR (
        owner_id IS NOT NULL
        AND agent_id IS NOT NULL
        AND owner_session_id IS NOT NULL
        AND selected_at IS NOT NULL
        AND status IN ('selected', 'consumed', 'denied', 'expired')
      )
    ),
  CONSTRAINT oauth_authorization_requests_grant_shape
    CHECK ((status = 'consumed') = (grant_id IS NOT NULL)),
  CONSTRAINT oauth_authorization_requests_terminal_shape
    CHECK (
      (status IN ('consumed', 'denied', 'expired')) = (terminal_at IS NOT NULL)
      AND (status = 'consumed') = (consumed_at IS NOT NULL)
    ),
  CONSTRAINT oauth_authorization_requests_expiry_window
    CHECK (
      expires_at > created_at
      AND expires_at <= created_at + interval '5 minutes'
    ),
  CONSTRAINT oauth_authorization_requests_event_order
    CHECK (
      (selected_at IS NULL OR selected_at >= created_at)
      AND (consumed_at IS NULL OR consumed_at >= created_at)
      AND (terminal_at IS NULL OR terminal_at >= created_at)
      AND updated_at >= created_at
    )
);

CREATE INDEX oauth_authorization_requests_expiry_idx
  ON platform.oauth_authorization_requests (expires_at, id)
  WHERE status IN ('pending', 'selected');

CREATE INDEX oauth_authorization_requests_selection_idx
  ON platform.oauth_authorization_requests (
    owner_id,
    owner_session_id,
    status,
    created_at DESC,
    id
  )
  WHERE owner_id IS NOT NULL;

COMMENT ON TABLE platform.oauth_authorization_requests IS
  'Five-minute, one-shot RFC 8707 binding envelope. binding_digest is a keyed digest over client_id, exact redirect_uri, canonical scopes, and the high-entropy S256 challenge; OAuth state and code verifier are never stored here.';

COMMENT ON COLUMN platform.oauth_authorization_requests.owner_session_id IS
  'Better Auth session id bound and revalidated at Agent selection. It is deliberately not an FK so normal session expiry cleanup cannot mutate or strand the five-minute audit envelope.';

CREATE FUNCTION platform.validate_oauth_authorization_request_insert()
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
    client.scopes,
    client.redirect_uris,
    client.grant_types
  INTO client_record
  FROM auth.oauth_clients AS client
  WHERE client.client_id = NEW.oauth_client_id
  FOR SHARE;

  IF NOT FOUND
    OR client_record.disabled IS TRUE
    OR client_record.skip_consent IS TRUE
    OR client_record.require_pkce IS FALSE
    OR NOT (client_record.redirect_uris ? NEW.redirect_uri)
    OR (
      client_record.grant_types IS NOT NULL
      AND NOT (client_record.grant_types ? 'authorization_code')
    )
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

CREATE TRIGGER oauth_authorization_requests_validate_insert
BEFORE INSERT ON platform.oauth_authorization_requests
FOR EACH ROW
EXECUTE FUNCTION platform.validate_oauth_authorization_request_insert();

REVOKE ALL ON FUNCTION platform.validate_oauth_authorization_request_insert()
  FROM PUBLIC;

CREATE TABLE platform.oauth_grants (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  owner_id uuid NOT NULL,
  auth_user_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  credential_id uuid NOT NULL,
  authorization_request_id uuid NOT NULL UNIQUE,
  oauth_client_id text NOT NULL
    REFERENCES auth.oauth_clients(client_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  resource text NOT NULL,
  scopes text[] NOT NULL,
  offline_access boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending',
  token_epoch bigint NOT NULL DEFAULT 1,
  consented_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  activated_at timestamptz,
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  expired_at timestamptz,
  revoked_at timestamptz,
  compromised_at timestamptz,
  reason_code text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT oauth_grants_id_owner_agent_unique
    UNIQUE (id, owner_id, agent_id),
  CONSTRAINT oauth_grants_credential_unique
    UNIQUE (credential_id),
  CONSTRAINT oauth_grants_owner_auth_user
    FOREIGN KEY (owner_id, auth_user_id)
    REFERENCES platform.owners(id, auth_user_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT oauth_grants_agent_owner
    FOREIGN KEY (agent_id, owner_id)
    REFERENCES platform.agents(id, owner_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT oauth_grants_credential_chain
    FOREIGN KEY (credential_id, owner_id, agent_id)
    REFERENCES platform.credentials(id, owner_id, agent_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT oauth_grants_authorization_request
    FOREIGN KEY (authorization_request_id, owner_id, agent_id)
    REFERENCES platform.oauth_authorization_requests(id, owner_id, agent_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT oauth_grants_configured_resource
    FOREIGN KEY (resource)
    REFERENCES platform.oauth_resource_configuration(resource)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT oauth_grants_resource
    CHECK (platform.oauth_resource_is_valid(resource)),
  CONSTRAINT oauth_grants_scopes
    CHECK (platform.agent_scopes_are_valid(scopes)),
  CONSTRAINT oauth_grants_status
    CHECK (status IN ('pending', 'active', 'expired', 'revoked', 'compromised')),
  CONSTRAINT oauth_grants_token_epoch_positive
    CHECK (token_epoch > 0),
  CONSTRAINT oauth_grants_lifecycle_shape
    CHECK (
      (
        status = 'pending'
        AND activated_at IS NULL
        AND expired_at IS NULL
        AND revoked_at IS NULL
        AND compromised_at IS NULL
        AND reason_code IS NULL
      )
      OR (
        status = 'active'
        AND activated_at IS NOT NULL
        AND expired_at IS NULL
        AND revoked_at IS NULL
        AND compromised_at IS NULL
        AND reason_code IS NULL
      )
      OR (
        status = 'expired'
        AND expired_at IS NOT NULL
        AND revoked_at IS NULL
        AND compromised_at IS NULL
        AND reason_code IS NOT NULL
        AND (
          activated_at IS NULL
          OR (
            activated_at IS NOT NULL
            AND expired_at >= expires_at
            AND reason_code = 'grant_absolute_expiry'
          )
        )
      )
      OR (
        status = 'revoked'
        AND expired_at IS NULL
        AND revoked_at IS NOT NULL
        AND compromised_at IS NULL
        AND reason_code IS NOT NULL
      )
      OR (
        status = 'compromised'
        AND expired_at IS NULL
        AND revoked_at IS NOT NULL
        AND compromised_at IS NOT NULL
        AND reason_code IS NOT NULL
      )
    ),
  CONSTRAINT oauth_grants_reason_code
    CHECK (
      reason_code IS NULL
      OR reason_code ~ '^[a-z0-9][a-z0-9_.-]{0,119}$'
    ),
  CONSTRAINT oauth_grants_absolute_expiry
    CHECK (
      expires_at > consented_at
      AND expires_at <= consented_at + interval '30 days'
    ),
  CONSTRAINT oauth_grants_created_matches_consent
    CHECK (created_at = consented_at),
  CONSTRAINT oauth_grants_event_order
    CHECK (
      (activated_at IS NULL OR activated_at >= consented_at)
      AND (last_used_at IS NULL OR last_used_at >= consented_at)
      AND (expired_at IS NULL OR expired_at >= consented_at)
      AND (revoked_at IS NULL OR revoked_at >= consented_at)
      AND (compromised_at IS NULL OR compromised_at >= consented_at)
      AND updated_at >= created_at
    )
);

ALTER TABLE platform.oauth_authorization_requests
  ADD CONSTRAINT oauth_authorization_requests_grant
  FOREIGN KEY (grant_id, owner_id, agent_id)
  REFERENCES platform.oauth_grants(id, owner_id, agent_id)
  ON UPDATE RESTRICT
  ON DELETE RESTRICT;

CREATE UNIQUE INDEX oauth_grants_one_current_per_agent_client
  ON platform.oauth_grants (agent_id, oauth_client_id)
  WHERE status IN ('pending', 'active');

CREATE INDEX oauth_grants_owner_history_idx
  ON platform.oauth_grants (owner_id, created_at DESC, id);

CREATE INDEX oauth_grants_client_auth_user_status_idx
  ON platform.oauth_grants (
    oauth_client_id,
    auth_user_id,
    status,
    expires_at,
    id
  );

CREATE INDEX oauth_grants_active_expiry_idx
  ON platform.oauth_grants (expires_at, id)
  WHERE status = 'active';

COMMENT ON TABLE platform.oauth_grants IS
  'Agent-bound OAuth authority. Each row binds one pre-registered client, Owner, Agent, oauth_grant Credential, exact MCP resource, frozen domain scopes, absolute expiry, and revocation epoch. Pending rows expire with their five-minute Authorization Request; active rows become terminal at absolute expiry so neither can permanently block reauthorization.';

COMMENT ON COLUMN platform.oauth_grants.token_epoch IS
  'Monotonic Grant epoch copied into each JWT authority record. Revocation and compromise increase it to invalidate earlier access tokens; natural expiry keeps it because every token is clamped to the fixed Grant/Credential expiry.';

-- A partial unique index protects the one-current-Grant invariant. This
-- targeted cleanup runs before each replacement Grant insert so a crashed
-- consent flow can block the same Agent/client pair for at most the original
-- five-minute Authorization Request window. It is also callable by a worker
-- for explicit lifecycle maintenance.
CREATE FUNCTION platform.expire_stale_oauth_pending_grants(
  target_agent_id uuid,
  target_oauth_client_id text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  expired_count integer;
BEGIN
  IF target_agent_id IS NULL
    OR target_oauth_client_id IS NULL
    OR length(target_oauth_client_id) = 0 THEN
    RAISE EXCEPTION 'OAuth pending Grant cleanup requires an Agent and client'
      USING ERRCODE = '22023';
  END IF;

  -- Preserve the Authorization Request audit trail while making an expired
  -- selected request terminal. Consumed and denied requests are already
  -- terminal and are left unchanged.
  UPDATE platform.oauth_authorization_requests AS authorization_request
  SET status = 'expired'
  WHERE authorization_request.status = 'selected'
    AND authorization_request.expires_at <= statement_timestamp()
    AND EXISTS (
      SELECT 1
      FROM platform.oauth_grants AS oauth_grant
      WHERE oauth_grant.authorization_request_id = authorization_request.id
        AND oauth_grant.agent_id = target_agent_id
        AND oauth_grant.oauth_client_id = target_oauth_client_id
        AND oauth_grant.status = 'pending'
    );

  UPDATE platform.oauth_grants AS oauth_grant
  SET status = 'expired',
      reason_code = CASE
        WHEN authorization_request.status = 'denied'
          THEN 'authorization_request_denied'
        ELSE 'authorization_request_expired'
      END
  FROM platform.oauth_authorization_requests AS authorization_request
  WHERE oauth_grant.authorization_request_id = authorization_request.id
    AND oauth_grant.agent_id = target_agent_id
    AND oauth_grant.oauth_client_id = target_oauth_client_id
    AND oauth_grant.status = 'pending'
    AND (
      authorization_request.status IN ('denied', 'expired')
      OR authorization_request.expires_at <= statement_timestamp()
    );

  GET DIAGNOSTICS expired_count = ROW_COUNT;
  RETURN expired_count;
END;
$$;

REVOKE ALL ON FUNCTION platform.expire_stale_oauth_pending_grants(uuid, text)
  FROM PUBLIC;

-- Natural expiry already fails closed at every token and resource boundary, but
-- the partial unique index still treats an active row as current. Terminalize
-- the one expired active predecessor before a replacement insert checks that
-- index. The UPDATE takes the predecessor row lock and remains in the caller's
-- transaction, so concurrent replacements still serialize through the unique
-- constraint.
CREATE FUNCTION platform.expire_stale_oauth_active_grants(
  target_agent_id uuid,
  target_oauth_client_id text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  expired_count integer;
BEGIN
  IF target_agent_id IS NULL
    OR target_oauth_client_id IS NULL
    OR length(target_oauth_client_id) = 0 THEN
    RAISE EXCEPTION 'OAuth active Grant cleanup requires an Agent and client'
      USING ERRCODE = '22023';
  END IF;

  UPDATE platform.oauth_grants AS oauth_grant
  SET status = 'expired'
  WHERE oauth_grant.agent_id = target_agent_id
    AND oauth_grant.oauth_client_id = target_oauth_client_id
    AND oauth_grant.status = 'active'
    AND oauth_grant.expires_at <= statement_timestamp();

  GET DIAGNOSTICS expired_count = ROW_COUNT;
  RETURN expired_count;
END;
$$;

REVOKE ALL ON FUNCTION platform.expire_stale_oauth_active_grants(uuid, text)
  FROM PUBLIC;

CREATE TABLE platform.oauth_access_token_jtis (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  jti_digest bytea NOT NULL UNIQUE,
  grant_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  grant_epoch bigint NOT NULL,
  oauth_client_id text NOT NULL,
  resource text NOT NULL,
  scopes text[] NOT NULL,
  status text NOT NULL DEFAULT 'active',
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revocation_reason_code text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT oauth_access_token_jtis_grant_chain
    FOREIGN KEY (grant_id, owner_id, agent_id)
    REFERENCES platform.oauth_grants(id, owner_id, agent_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT oauth_access_token_jtis_configured_resource
    FOREIGN KEY (resource)
    REFERENCES platform.oauth_resource_configuration(resource)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT oauth_access_token_jtis_digest
    CHECK (octet_length(jti_digest) = 32),
  CONSTRAINT oauth_access_token_jtis_grant_epoch
    CHECK (grant_epoch > 0),
  CONSTRAINT oauth_access_token_jtis_client_id
    CHECK (
      length(oauth_client_id) BETWEEN 1 AND 200
      AND oauth_client_id !~ '[[:space:][:cntrl:]]'
    ),
  CONSTRAINT oauth_access_token_jtis_resource
    CHECK (platform.oauth_resource_is_valid(resource)),
  CONSTRAINT oauth_access_token_jtis_scopes
    CHECK (platform.agent_scopes_are_valid(scopes)),
  CONSTRAINT oauth_access_token_jtis_status
    CHECK (status IN ('active', 'revoked')),
  CONSTRAINT oauth_access_token_jtis_revocation_shape
    CHECK (
      (
        status = 'active'
        AND revoked_at IS NULL
        AND revocation_reason_code IS NULL
      )
      OR (
        status = 'revoked'
        AND revoked_at IS NOT NULL
        AND revocation_reason_code IS NOT NULL
      )
    ),
  CONSTRAINT oauth_access_token_jtis_revocation_reason
    CHECK (
      revocation_reason_code IS NULL
      OR revocation_reason_code ~ '^[a-z0-9][a-z0-9_.-]{0,119}$'
    ),
  CONSTRAINT oauth_access_token_jtis_short_lived
    CHECK (
      expires_at > issued_at
      AND expires_at <= issued_at + interval '10 minutes'
    ),
  CONSTRAINT oauth_access_token_jtis_event_order
    CHECK (
      created_at = issued_at
      AND updated_at >= created_at
      AND (revoked_at IS NULL OR revoked_at >= issued_at)
    )
);

CREATE INDEX oauth_access_token_jtis_grant_active_idx
  ON platform.oauth_access_token_jtis (
    grant_id,
    grant_epoch,
    expires_at,
    id
  )
  WHERE status = 'active';

CREATE INDEX oauth_access_token_jtis_expiry_idx
  ON platform.oauth_access_token_jtis (expires_at, id);

COMMENT ON TABLE platform.oauth_access_token_jtis IS
  'Audit-safe JWT access-token admission and explicit revocation state. Only a keyed 32-byte jti digest is stored; raw JWTs, Authorization headers, and raw jti values are forbidden.';

CREATE FUNCTION platform.validate_oauth_grant_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  client_record record;
  credential_record record;
  request_record record;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'oauth_grants'
    OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'OAuth Grant validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.status IS DISTINCT FROM 'pending'
    OR NEW.token_epoch IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'A new OAuth Grant must start pending at epoch one'
      USING ERRCODE = '23514';
  END IF;

  -- Terminalize time-expired predecessors for this exact Agent/client pair
  -- before the current-Grant unique index is checked. Both updates and this
  -- insert remain atomic in the caller's transaction.
  PERFORM platform.expire_stale_oauth_pending_grants(
    NEW.agent_id,
    NEW.oauth_client_id
  );
  PERFORM platform.expire_stale_oauth_active_grants(
    NEW.agent_id,
    NEW.oauth_client_id
  );

  SELECT
    credential.credential_type,
    credential.scopes,
    credential.audience,
    credential.issued_at,
    credential.expires_at,
    credential.revoked_at
  INTO credential_record
  FROM platform.credentials AS credential
  WHERE credential.id = NEW.credential_id
    AND credential.owner_id = NEW.owner_id
    AND credential.agent_id = NEW.agent_id
  FOR SHARE;

  IF NOT FOUND
    OR credential_record.credential_type IS DISTINCT FROM 'oauth_grant'
    OR credential_record.scopes IS DISTINCT FROM NEW.scopes
    OR credential_record.audience IS DISTINCT FROM NEW.resource
    OR credential_record.expires_at IS DISTINCT FROM NEW.expires_at
    OR credential_record.revoked_at IS NOT NULL
    OR credential_record.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION
      'OAuth Grant must exactly match an active oauth_grant Credential authority snapshot'
      USING ERRCODE = '23514';
  END IF;

  SELECT
    request.owner_id,
    request.agent_id,
    request.oauth_client_id,
    request.resource,
    request.requested_scopes,
    request.redirect_uri,
    request.status,
    request.expires_at
  INTO request_record
  FROM platform.oauth_authorization_requests AS request
  WHERE request.id = NEW.authorization_request_id
  FOR UPDATE;

  IF NOT FOUND
    OR request_record.owner_id IS DISTINCT FROM NEW.owner_id
    OR request_record.agent_id IS DISTINCT FROM NEW.agent_id
    OR request_record.oauth_client_id IS DISTINCT FROM NEW.oauth_client_id
    OR request_record.resource IS DISTINCT FROM NEW.resource
    OR request_record.status IS DISTINCT FROM 'selected'
    OR request_record.expires_at <= statement_timestamp()
    OR NOT platform.oauth_text_arrays_are_same_set(
      array_remove(request_record.requested_scopes, 'offline_access'),
      NEW.scopes
    )
    OR NEW.offline_access IS DISTINCT FROM
      ('offline_access' = ANY(request_record.requested_scopes)) THEN
    RAISE EXCEPTION
      'OAuth Grant must match the live selected Authorization Request'
      USING ERRCODE = '23514';
  END IF;

  SELECT client.disabled, client.scopes, client.redirect_uris
  INTO client_record
  FROM auth.oauth_clients AS client
  WHERE client.client_id = NEW.oauth_client_id
  FOR SHARE;

  IF NOT FOUND OR client_record.disabled IS TRUE THEN
    RAISE EXCEPTION 'OAuth Grant client is disabled or missing'
      USING ERRCODE = '42501';
  END IF;

  IF NOT (client_record.redirect_uris ? request_record.redirect_uri) THEN
    RAISE EXCEPTION 'OAuth Authorization Request redirect URI is not registered'
      USING ERRCODE = '23514';
  END IF;

  IF client_record.scopes IS NULL
    OR EXISTS (
      SELECT 1
      FROM unnest(
        CASE
          WHEN NEW.offline_access THEN NEW.scopes || 'offline_access'::text
          ELSE NEW.scopes
        END
      ) AS requested(scope)
      WHERE NOT (client_record.scopes ? requested.scope)
    ) THEN
    RAISE EXCEPTION 'OAuth Client scope configuration is invalid'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER oauth_grants_validate_insert
BEFORE INSERT ON platform.oauth_grants
FOR EACH ROW
EXECUTE FUNCTION platform.validate_oauth_grant_insert();

REVOKE ALL ON FUNCTION platform.validate_oauth_grant_insert() FROM PUBLIC;

CREATE FUNCTION platform.prepare_oauth_grant_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  request_record record;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'oauth_grants'
    OR TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'OAuth Grant update guard invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.auth_user_id IS DISTINCT FROM OLD.auth_user_id
    OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
    OR NEW.credential_id IS DISTINCT FROM OLD.credential_id
    OR NEW.authorization_request_id IS DISTINCT FROM OLD.authorization_request_id
    OR NEW.oauth_client_id IS DISTINCT FROM OLD.oauth_client_id
    OR NEW.resource IS DISTINCT FROM OLD.resource
    OR NEW.scopes IS DISTINCT FROM OLD.scopes
    OR NEW.offline_access IS DISTINCT FROM OLD.offline_access
    OR NEW.consented_at IS DISTINCT FROM OLD.consented_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'OAuth Grant identity and authority are immutable'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.status IN ('expired', 'revoked', 'compromised') THEN
    RAISE EXCEPTION 'A terminal OAuth Grant is immutable'
      USING ERRCODE = '22023';
  END IF;

  IF NEW.token_epoch < OLD.token_epoch
    OR NEW.token_epoch > OLD.token_epoch + 1 THEN
    RAISE EXCEPTION 'OAuth Grant token epoch advances one step at a time'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.last_used_at IS NOT NULL
    AND (NEW.last_used_at IS NULL OR NEW.last_used_at < OLD.last_used_at) THEN
    RAISE EXCEPTION 'OAuth Grant last-used time is monotonic'
      USING ERRCODE = '22023';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'pending' AND NEW.status = 'active' THEN
      SELECT request.status, request.expires_at
      INTO request_record
      FROM platform.oauth_authorization_requests AS request
      WHERE request.id = NEW.authorization_request_id
        AND request.grant_id = NEW.id;

      IF request_record.status IS DISTINCT FROM 'consumed' THEN
        RAISE EXCEPTION
          'OAuth Grant activates only after its Authorization Request is consumed'
          USING ERRCODE = '23514';
      END IF;

      NEW.activated_at := coalesce(NEW.activated_at, statement_timestamp());
    ELSIF OLD.status = 'pending' AND NEW.status = 'expired' THEN
      SELECT request.status, request.expires_at
      INTO request_record
      FROM platform.oauth_authorization_requests AS request
      WHERE request.id = NEW.authorization_request_id;

      IF NOT FOUND
        OR NOT (
          request_record.status IN ('denied', 'expired')
          OR request_record.expires_at <= statement_timestamp()
        ) THEN
        RAISE EXCEPTION
          'A pending OAuth Grant expires only with its Authorization Request'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.token_epoch <> OLD.token_epoch THEN
        RAISE EXCEPTION 'Expiring an unactivated OAuth Grant keeps its token epoch'
          USING ERRCODE = '23514';
      END IF;

      NEW.expired_at := coalesce(NEW.expired_at, statement_timestamp());
      NEW.reason_code := coalesce(
        NEW.reason_code,
        CASE
          WHEN request_record.status = 'denied'
            THEN 'authorization_request_denied'
          ELSE 'authorization_request_expired'
        END
      );
    ELSIF OLD.status = 'active' AND NEW.status = 'expired' THEN
      IF OLD.expires_at > statement_timestamp() THEN
        RAISE EXCEPTION 'An active OAuth Grant expires only at absolute expiry'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.token_epoch <> OLD.token_epoch THEN
        RAISE EXCEPTION 'Natural OAuth Grant expiry keeps its token epoch'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.activated_at IS DISTINCT FROM OLD.activated_at
        OR NEW.expired_at IS NOT NULL
        OR NEW.reason_code IS NOT NULL THEN
        RAISE EXCEPTION 'Natural OAuth Grant expiry fields are trigger-managed'
          USING ERRCODE = '23514';
      END IF;

      -- Provider and JTI triggers clamp every token to this same fixed expiry,
      -- so no token can remain live here and an epoch increment is unnecessary.
      NEW.expired_at := statement_timestamp();
      NEW.reason_code := 'grant_absolute_expiry';
    ELSIF OLD.status IN ('pending', 'active')
      AND NEW.status IN ('revoked', 'compromised') THEN
      IF NEW.token_epoch <> OLD.token_epoch + 1 THEN
        RAISE EXCEPTION 'Terminating an OAuth Grant must increase token epoch'
          USING ERRCODE = '23514';
      END IF;
      NEW.revoked_at := coalesce(NEW.revoked_at, statement_timestamp());
      IF NEW.status = 'compromised' THEN
        NEW.compromised_at := coalesce(
          NEW.compromised_at,
          statement_timestamp()
        );
      END IF;
    ELSE
      RAISE EXCEPTION 'Illegal OAuth Grant status transition'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER oauth_grants_prepare_update
BEFORE UPDATE ON platform.oauth_grants
FOR EACH ROW
EXECUTE FUNCTION platform.prepare_oauth_grant_update();

REVOKE ALL ON FUNCTION platform.prepare_oauth_grant_update() FROM PUBLIC;

CREATE FUNCTION platform.prepare_oauth_authorization_request_update()
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

    SELECT session.user_id
    INTO session_user_id
    FROM auth.sessions AS session
    WHERE session.id = NEW.owner_session_id
      AND session.expires_at > statement_timestamp();

    SELECT owner.auth_user_id
    INTO owner_auth_user_id
    FROM platform.owners AS owner
    INNER JOIN platform.agents AS agent
      ON agent.id = NEW.agent_id
     AND agent.owner_id = owner.id
     AND agent.status = 'active'
     AND agent.deleted_at IS NULL
    INNER JOIN platform.actors AS actor
      ON actor.id = agent.actor_id
     AND actor.owner_id = owner.id
     AND actor.kind = 'agent'
     AND actor.status = 'active'
     AND actor.deleted_at IS NULL
    WHERE owner.id = NEW.owner_id
      AND owner.status = 'active'
      AND owner.email_verified_at IS NOT NULL
      AND owner.deleted_at IS NULL;

    IF session_user_id IS NULL
      OR owner_auth_user_id IS DISTINCT FROM session_user_id THEN
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

CREATE TRIGGER oauth_authorization_requests_prepare_update
BEFORE UPDATE ON platform.oauth_authorization_requests
FOR EACH ROW
EXECUTE FUNCTION platform.prepare_oauth_authorization_request_update();

REVOKE ALL ON FUNCTION platform.prepare_oauth_authorization_request_update()
  FROM PUBLIC;

CREATE FUNCTION platform.validate_oauth_access_token_jti_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  authority record;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'oauth_access_token_jtis'
    OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'OAuth access-token jti validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  SELECT
    oauth_grant.owner_id,
    oauth_grant.agent_id,
    oauth_grant.credential_id,
    oauth_grant.oauth_client_id,
    oauth_grant.resource,
    oauth_grant.scopes,
    oauth_grant.status,
    oauth_grant.token_epoch,
    oauth_grant.expires_at AS grant_expires_at,
    credential.revoked_at AS credential_revoked_at,
    credential.expires_at AS credential_expires_at
  INTO authority
  FROM platform.oauth_grants AS oauth_grant
  INNER JOIN platform.credentials AS credential
    ON credential.id = oauth_grant.credential_id
   AND credential.owner_id = oauth_grant.owner_id
   AND credential.agent_id = oauth_grant.agent_id
  WHERE oauth_grant.id = NEW.grant_id
  FOR SHARE OF oauth_grant, credential;

  IF NOT FOUND
    OR authority.owner_id IS DISTINCT FROM NEW.owner_id
    OR authority.agent_id IS DISTINCT FROM NEW.agent_id
    OR authority.oauth_client_id IS DISTINCT FROM NEW.oauth_client_id
    OR authority.resource IS DISTINCT FROM NEW.resource
    OR NOT platform.oauth_text_arrays_are_same_set(
      authority.scopes,
      NEW.scopes
    )
    OR authority.status IS DISTINCT FROM 'active'
    OR authority.token_epoch IS DISTINCT FROM NEW.grant_epoch
    OR authority.grant_expires_at < NEW.expires_at
    OR authority.credential_revoked_at IS NOT NULL
    OR authority.credential_expires_at < NEW.expires_at THEN
    RAISE EXCEPTION 'OAuth access-token jti must match current Grant authority'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status IS DISTINCT FROM 'active'
    OR NEW.revoked_at IS NOT NULL
    OR NEW.revocation_reason_code IS NOT NULL THEN
    RAISE EXCEPTION 'A new OAuth access-token jti must start active'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER oauth_access_token_jtis_validate_insert
BEFORE INSERT ON platform.oauth_access_token_jtis
FOR EACH ROW
EXECUTE FUNCTION platform.validate_oauth_access_token_jti_insert();

REVOKE ALL ON FUNCTION platform.validate_oauth_access_token_jti_insert()
  FROM PUBLIC;

CREATE FUNCTION platform.prepare_oauth_access_token_jti_update()
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

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER oauth_access_token_jtis_prepare_update
BEFORE UPDATE ON platform.oauth_access_token_jtis
FOR EACH ROW
EXECUTE FUNCTION platform.prepare_oauth_access_token_jti_update();

REVOKE ALL ON FUNCTION platform.prepare_oauth_access_token_jti_update()
  FROM PUBLIC;

-- Provider rows carry the Grant id through reference_id. These triggers make
-- client, Better Auth user, Grant, and frozen scope mismatches impossible even
-- for an out-of-band writer. Provider refresh rotation itself remains in the
-- canonical auth tables; AlphaNet does not duplicate token-family state. The
-- Provider issues sliding lifetimes, so every token insertion is clamped to the
-- earlier fixed Grant/Credential absolute expiry without extending either
-- authority row.
-- V1 intentionally has one exact scope set per Grant. The token endpoint may
-- omit scope to reuse that set, but neither narrowed nor expanded Provider rows
-- are admitted; a future subset profile requires a derived authority model.
CREATE FUNCTION platform.validate_oauth_provider_grant_reference()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  grant_uuid uuid;
  grant_found boolean;
  grant_record record;
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

  SELECT
    oauth_grant.auth_user_id,
    oauth_grant.oauth_client_id,
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
  FROM jsonb_array_elements(NEW.scopes) AS member(value);

  SELECT array_agg(scope ORDER BY scope)
  INTO expected_scopes
  FROM unnest(
    CASE
      WHEN grant_record.offline_access
        THEN grant_record.scopes || 'offline_access'::text
      ELSE grant_record.scopes
    END
  ) AS value(scope);

  IF NOT grant_found
    OR grant_record.auth_user_id IS DISTINCT FROM NEW.user_id
    OR grant_record.oauth_client_id IS DISTINCT FROM NEW.client_id
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
    NEW.expires_at := least(NEW.expires_at, authority_expires_at);

    IF NEW.expires_at <= NEW.created_at
      OR NEW.expires_at <= statement_timestamp() THEN
      RAISE EXCEPTION 'OAuth token authority has reached absolute expiry'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER oauth_consents_validate_grant_reference
BEFORE INSERT OR UPDATE OF client_id, user_id, reference_id, scopes
ON auth.oauth_consents
FOR EACH ROW
EXECUTE FUNCTION platform.validate_oauth_provider_grant_reference();

CREATE TRIGGER oauth_refresh_tokens_validate_grant_reference
BEFORE INSERT OR UPDATE OF client_id, user_id, reference_id, scopes
ON auth.oauth_refresh_tokens
FOR EACH ROW
EXECUTE FUNCTION platform.validate_oauth_provider_grant_reference();

CREATE TRIGGER oauth_access_tokens_validate_grant_reference
BEFORE INSERT OR UPDATE OF client_id, user_id, reference_id, scopes
ON auth.oauth_access_tokens
FOR EACH ROW
EXECUTE FUNCTION platform.validate_oauth_provider_grant_reference();

REVOKE ALL ON FUNCTION platform.validate_oauth_provider_grant_reference()
  FROM PUBLIC;

CREATE FUNCTION platform.prepare_oauth_refresh_token_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'auth'
    OR TG_TABLE_NAME <> 'oauth_refresh_tokens'
    OR TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'OAuth Refresh Token guard invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.token IS DISTINCT FROM OLD.token
    OR NEW.client_id IS DISTINCT FROM OLD.client_id
    OR NEW.session_id IS DISTINCT FROM OLD.session_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.reference_id IS DISTINCT FROM OLD.reference_id
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.auth_time IS DISTINCT FROM OLD.auth_time
    OR NEW.scopes IS DISTINCT FROM OLD.scopes THEN
    RAISE EXCEPTION 'OAuth Refresh Token identity is immutable'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.revoked IS NOT NULL
    OR NEW.revoked IS NULL
    OR NEW.revoked < OLD.created_at THEN
    RAISE EXCEPTION 'OAuth Refresh Token revocation is irreversible'
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER oauth_refresh_tokens_prepare_update
BEFORE UPDATE ON auth.oauth_refresh_tokens
FOR EACH ROW
EXECUTE FUNCTION platform.prepare_oauth_refresh_token_update();

REVOKE ALL ON FUNCTION platform.prepare_oauth_refresh_token_update()
  FROM PUBLIC;

CREATE FUNCTION platform.prevent_oauth_access_token_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'auth'
    OR TG_TABLE_NAME <> 'oauth_access_tokens'
    OR TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'OAuth opaque Access Token guard invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  RAISE EXCEPTION 'OAuth opaque Access Tokens are immutable; revoke by deletion'
    USING ERRCODE = '22023';
END;
$$;

CREATE TRIGGER oauth_access_tokens_prevent_update
BEFORE UPDATE ON auth.oauth_access_tokens
FOR EACH ROW
EXECUTE FUNCTION platform.prevent_oauth_access_token_update();

REVOKE ALL ON FUNCTION platform.prevent_oauth_access_token_update()
  FROM PUBLIC;
