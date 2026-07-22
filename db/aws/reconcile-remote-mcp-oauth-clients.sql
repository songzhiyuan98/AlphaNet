-- Invoked only by db/scripts/aws-reconcile-remote-mcp-oauth-clients.sh after
-- that wrapper has begun a transaction and copied one base64 document into
-- pg_temp.alphanet_remote_mcp_oauth_manifest_input. Values deliberately never
-- enter psql argv or SQL statement text.

SET LOCAL search_path = pg_catalog;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

SELECT pg_advisory_xact_lock(
  hashtextextended('alphanet:remote-mcp-oauth-provisioning:v1', 0)
);

CREATE TEMP TABLE alphanet_remote_mcp_oauth_manifest (
  resource text NOT NULL
) ON COMMIT DROP;

CREATE TEMP TABLE alphanet_remote_mcp_oauth_manifest_clients (
  client_id text PRIMARY KEY,
  name text NOT NULL,
  redirect_uris jsonb NOT NULL,
  scopes jsonb NOT NULL,
  grant_types jsonb NOT NULL
) ON COMMIT DROP;

DO $validation$
DECLARE
  allowed_scopes constant text[] := ARRAY[
    'research:read',
    'community:read',
    'notifications:read',
    'actions:read',
    'content:write',
    'reaction:write',
    'follow:write',
    'offline_access'
  ]::text[];
  domain_scopes constant text[] := ARRAY[
    'research:read',
    'community:read',
    'notifications:read',
    'actions:read',
    'content:write',
    'reaction:write',
    'follow:write'
  ]::text[];
  client_record record;
  client_document json;
  client_id text;
  client_name text;
  client_key_count integer;
  client_distinct_key_count integer;
  grant_types text[];
  canonical_scopes text[];
  hostname text;
  hostname_label text;
  expected_migration_role text;
  expected_resource text;
  manifest json;
  manifest_client_count integer;
  manifest_distinct_key_count integer;
  manifest_key_count integer;
  manifest_resource text;
  port_number integer;
  port_text text;
  previous_client_id text;
  redirect_authority text;
  redirect_path_and_query text;
  redirect_uri text;
  redirect_uri_parts text[];
  redirect_uris text[];
  scopes text[];
BEGIN
  IF (
    SELECT count(*)
    FROM pg_temp.alphanet_remote_mcp_oauth_expected_configuration
  ) <> 1 THEN
    RAISE EXCEPTION 'Exactly one Remote MCP OAuth expected configuration is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT migration_role,
         nullif(convert_from(decode(encoded_resource, 'base64'), 'UTF8'), '')
  INTO STRICT expected_migration_role, expected_resource
  FROM pg_temp.alphanet_remote_mcp_oauth_expected_configuration;

  IF current_user IS DISTINCT FROM expected_migration_role THEN
    RAISE EXCEPTION 'Remote MCP OAuth provisioning requires the migration role'
      USING ERRCODE = '42501';
  END IF;

  IF to_regclass('auth.oauth_clients') IS NULL
    OR to_regclass('platform.oauth_resource_configuration') IS NULL
    OR to_regclass('system.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'Remote MCP OAuth schema is incomplete'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE (namespace.nspname, relation.relname) IN (
      ('auth', 'oauth_clients'),
      ('platform', 'oauth_resource_configuration')
    )
      AND pg_get_userbyid(relation.relowner) IS DISTINCT FROM current_user
  ) THEN
    RAISE EXCEPTION 'Remote MCP OAuth provisioning requires the table owner'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM system.schema_migrations
    WHERE version = '000018'
      AND name = 'remote_mcp_oauth_v1'
  ) OR NOT EXISTS (
    SELECT 1
    FROM system.schema_migrations
    WHERE version = '000019'
      AND name = 'remote_mcp_oauth_hardening_v1'
  ) OR NOT EXISTS (
    SELECT 1
    FROM system.schema_migrations
    WHERE version = '000020'
      AND name = 'remote_mcp_oauth_lifecycle_maintenance_v1'
  ) THEN
    RAISE EXCEPTION 'Remote MCP OAuth migrations are incomplete'
      USING ERRCODE = '55000';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_temp.alphanet_remote_mcp_oauth_manifest_input
  ) <> 1 THEN
    RAISE EXCEPTION 'Exactly one Remote MCP OAuth manifest is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT convert_from(decode(encoded_document, 'base64'), 'UTF8')::json
  INTO STRICT manifest
  FROM pg_temp.alphanet_remote_mcp_oauth_manifest_input;

  IF json_typeof(manifest) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Remote MCP OAuth manifest must be an object'
      USING ERRCODE = '22023';
  END IF;

  SELECT count(*), count(DISTINCT entry.key)
  INTO manifest_key_count, manifest_distinct_key_count
  FROM json_each(manifest) AS entry;

  IF manifest_key_count <> 3
    OR manifest_distinct_key_count <> 3
    OR EXISTS (
      SELECT 1
      FROM json_each(manifest) AS entry
      WHERE entry.key <> ALL (ARRAY['schema_version', 'resource', 'clients'])
    ) THEN
    RAISE EXCEPTION 'Remote MCP OAuth manifest fields are incomplete or unreviewed'
      USING ERRCODE = '22023';
  END IF;

  IF json_typeof(manifest -> 'schema_version') IS DISTINCT FROM 'number'
    OR manifest ->> 'schema_version' <> '1' THEN
    RAISE EXCEPTION 'Remote MCP OAuth manifest schema_version must be 1'
      USING ERRCODE = '22023';
  END IF;
  IF json_typeof(manifest -> 'resource') IS DISTINCT FROM 'string'
    OR json_typeof(manifest -> 'clients') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Remote MCP OAuth manifest has invalid field types'
      USING ERRCODE = '22023';
  END IF;

  manifest_resource := manifest ->> 'resource';
  IF platform.oauth_resource_is_valid(manifest_resource) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Remote MCP OAuth manifest resource is unsafe or noncanonical'
      USING ERRCODE = '22023';
  END IF;
  IF expected_resource IS NOT NULL
    AND manifest_resource IS DISTINCT FROM expected_resource THEN
    RAISE EXCEPTION 'Remote MCP OAuth manifest does not match the expected environment resource'
      USING ERRCODE = '22023';
  END IF;

  manifest_client_count := json_array_length(manifest -> 'clients');
  IF manifest_client_count > 100 THEN
    RAISE EXCEPTION 'Remote MCP OAuth manifest has too many clients'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO pg_temp.alphanet_remote_mcp_oauth_manifest (resource)
  VALUES (manifest_resource);

  FOR client_record IN
    SELECT entry.value AS document, entry.ordinality AS position
    FROM json_array_elements(manifest -> 'clients')
      WITH ORDINALITY AS entry(value, ordinality)
    ORDER BY entry.ordinality
  LOOP
    client_document := client_record.document;
    IF json_typeof(client_document) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Every Remote MCP OAuth client must be an object'
        USING ERRCODE = '22023';
    END IF;

    SELECT count(*), count(DISTINCT entry.key)
    INTO client_key_count, client_distinct_key_count
    FROM json_each(client_document) AS entry;

    IF client_key_count <> 5
      OR client_distinct_key_count <> 5
      OR EXISTS (
        SELECT 1
        FROM json_each(client_document) AS entry
        WHERE entry.key <> ALL (
          ARRAY['client_id', 'name', 'redirect_uris', 'scopes', 'grant_types']
        )
      ) THEN
      RAISE EXCEPTION 'OAuth client fields are incomplete or unreviewed'
        USING ERRCODE = '22023';
    END IF;

    IF json_typeof(client_document -> 'client_id') IS DISTINCT FROM 'string'
      OR json_typeof(client_document -> 'name') IS DISTINCT FROM 'string'
      OR json_typeof(client_document -> 'redirect_uris') IS DISTINCT FROM 'array'
      OR json_typeof(client_document -> 'scopes') IS DISTINCT FROM 'array'
      OR json_typeof(client_document -> 'grant_types') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'OAuth client fields have invalid types'
        USING ERRCODE = '22023';
    END IF;

    client_id := client_document ->> 'client_id';
    client_name := client_document ->> 'name';
    IF length(client_id) NOT BETWEEN 1 AND 200
      OR client_id ~ '[[:space:][:cntrl:]]'
      OR octet_length(convert_to(client_name, 'UTF8')) NOT BETWEEN 1 AND 200
      OR client_name IS DISTINCT FROM btrim(client_name)
      OR client_name ~ '[[:cntrl:]]' THEN
      RAISE EXCEPTION 'OAuth client identity is unsafe or noncanonical'
        USING ERRCODE = '22023';
    END IF;

    IF previous_client_id IS NOT NULL
      AND client_id COLLATE "C" <= previous_client_id COLLATE "C" THEN
      RAISE EXCEPTION 'OAuth clients must have unique client_id values in canonical order'
        USING ERRCODE = '22023';
    END IF;
    previous_client_id := client_id;

    IF EXISTS (
      SELECT 1
      FROM json_array_elements(client_document -> 'redirect_uris') AS member(value)
      WHERE json_typeof(member.value) IS DISTINCT FROM 'string'
    ) OR EXISTS (
      SELECT 1
      FROM json_array_elements(client_document -> 'scopes') AS member(value)
      WHERE json_typeof(member.value) IS DISTINCT FROM 'string'
    ) OR EXISTS (
      SELECT 1
      FROM json_array_elements(client_document -> 'grant_types') AS member(value)
      WHERE json_typeof(member.value) IS DISTINCT FROM 'string'
    ) THEN
      RAISE EXCEPTION 'OAuth client arrays may contain only strings'
        USING ERRCODE = '22023';
    END IF;

    SELECT coalesce(array_agg(member.value ORDER BY member.ordinality), ARRAY[]::text[])
    INTO redirect_uris
    FROM json_array_elements_text(client_document -> 'redirect_uris')
      WITH ORDINALITY AS member(value, ordinality);
    SELECT coalesce(array_agg(member.value ORDER BY member.ordinality), ARRAY[]::text[])
    INTO scopes
    FROM json_array_elements_text(client_document -> 'scopes')
      WITH ORDINALITY AS member(value, ordinality);
    SELECT coalesce(array_agg(member.value ORDER BY member.ordinality), ARRAY[]::text[])
    INTO grant_types
    FROM json_array_elements_text(client_document -> 'grant_types')
      WITH ORDINALITY AS member(value, ordinality);

    IF cardinality(redirect_uris) NOT BETWEEN 1 AND 20
      OR cardinality(ARRAY(SELECT DISTINCT uri FROM unnest(redirect_uris) AS uri))
        <> cardinality(redirect_uris)
      OR redirect_uris IS DISTINCT FROM ARRAY(
        SELECT uri
        FROM unnest(redirect_uris) AS uri
        ORDER BY uri COLLATE "C"
      )
      OR platform.oauth_redirect_uris_are_valid(to_jsonb(redirect_uris))
        IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'OAuth redirect URIs must be unique and in canonical order'
        USING ERRCODE = '22023';
    END IF;

    FOREACH redirect_uri IN ARRAY redirect_uris
    LOOP
      IF redirect_uri ~ '[[:space:][:cntrl:]%#]'
        OR redirect_uri ~ '[?]$'
        OR length(redirect_uri) - length(replace(redirect_uri, '?', '')) > 1 THEN
        RAISE EXCEPTION 'OAuth redirect URI is unsafe or noncanonical'
          USING ERRCODE = '22023';
      END IF;

      redirect_uri_parts := regexp_match(
        redirect_uri,
        $https_uri$^https://([^/]+)(/[A-Za-z0-9._~!$&'()*+,;=:@/?-]*)$$https_uri$
      );
      IF redirect_uri_parts IS NOT NULL THEN
        redirect_authority := redirect_uri_parts[1];
        redirect_path_and_query := redirect_uri_parts[2];
        redirect_uri_parts := regexp_match(
          redirect_authority,
          '^([a-z0-9.-]+)(:([1-9][0-9]{0,4}))?$'
        );
        IF redirect_uri_parts IS NULL THEN
          RAISE EXCEPTION 'OAuth HTTPS redirect authority is noncanonical'
            USING ERRCODE = '22023';
        END IF;
        hostname := redirect_uri_parts[1];
        port_text := redirect_uri_parts[3];
        IF length(hostname) > 253 OR hostname ~ '^[0-9.]+$' THEN
          RAISE EXCEPTION 'OAuth HTTPS redirect host is noncanonical'
            USING ERRCODE = '22023';
        END IF;
        FOREACH hostname_label IN ARRAY string_to_array(hostname, '.')
        LOOP
          IF length(hostname_label) NOT BETWEEN 1 AND 63
            OR hostname_label !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' THEN
            RAISE EXCEPTION 'OAuth HTTPS redirect host is noncanonical'
              USING ERRCODE = '22023';
          END IF;
        END LOOP;
        IF port_text IS NOT NULL THEN
          port_number := port_text::integer;
          IF port_number > 65535 OR port_number = 443 THEN
            RAISE EXCEPTION 'OAuth HTTPS redirect port is noncanonical'
              USING ERRCODE = '22023';
          END IF;
        END IF;
      ELSE
        redirect_uri_parts := regexp_match(
          redirect_uri,
          $loopback_uri$^http://(localhost|127[.]0[.]0[.]1|\[::1\])(:([1-9][0-9]{0,4}))?(/[A-Za-z0-9._~!$&'()*+,;=:@/?-]*)$$loopback_uri$
        );
        IF redirect_uri_parts IS NULL THEN
          RAISE EXCEPTION 'OAuth redirect URI must use HTTPS or canonical loopback HTTP'
            USING ERRCODE = '22023';
        END IF;
        port_text := redirect_uri_parts[3];
        redirect_path_and_query := redirect_uri_parts[4];
        IF port_text IS NOT NULL THEN
          port_number := port_text::integer;
          IF port_number > 65535 OR port_number = 80 THEN
            RAISE EXCEPTION 'OAuth loopback redirect port is noncanonical'
              USING ERRCODE = '22023';
          END IF;
        END IF;
      END IF;

      IF redirect_path_and_query ~ '//'
        OR redirect_path_and_query ~ '/[.]{1,2}(/|[?]|$)' THEN
        RAISE EXCEPTION 'OAuth redirect path is noncanonical'
          USING ERRCODE = '22023';
      END IF;
    END LOOP;

    IF cardinality(scopes) NOT BETWEEN 1 AND 8
      OR cardinality(ARRAY(SELECT DISTINCT scope FROM unnest(scopes) AS scope))
        <> cardinality(scopes)
      OR NOT (scopes <@ allowed_scopes)
      OR NOT (scopes && domain_scopes)
      OR platform.oauth_provider_scopes_are_valid(to_jsonb(scopes))
        IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'OAuth client scopes are invalid'
        USING ERRCODE = '22023';
    END IF;

    SELECT array_agg(scope ORDER BY array_position(allowed_scopes, scope))
    INTO canonical_scopes
    FROM unnest(scopes) AS scope;
    IF scopes IS DISTINCT FROM canonical_scopes THEN
      RAISE EXCEPTION 'OAuth client scopes are not in canonical order'
        USING ERRCODE = '22023';
    END IF;

    IF grant_types IS DISTINCT FROM ARRAY['authorization_code']::text[]
      AND grant_types IS DISTINCT FROM
        ARRAY['authorization_code', 'refresh_token']::text[] THEN
      RAISE EXCEPTION 'OAuth client grant_types are invalid or noncanonical'
        USING ERRCODE = '22023';
    END IF;
    IF ('offline_access' = ANY(scopes)) IS DISTINCT FROM
      ('refresh_token' = ANY(grant_types)) THEN
      RAISE EXCEPTION 'OAuth client offline scope and refresh grant do not match'
        USING ERRCODE = '22023';
    END IF;

    INSERT INTO pg_temp.alphanet_remote_mcp_oauth_manifest_clients (
      client_id,
      name,
      redirect_uris,
      scopes,
      grant_types
    ) VALUES (
      client_id,
      client_name,
      to_jsonb(redirect_uris),
      to_jsonb(scopes),
      to_jsonb(grant_types)
    );
  END LOOP;

  IF (
    SELECT count(*)
    FROM pg_temp.alphanet_remote_mcp_oauth_manifest_clients
  ) <> manifest_client_count THEN
    RAISE EXCEPTION 'Remote MCP OAuth client manifest is partial'
      USING ERRCODE = '22023';
  END IF;
END;
$validation$;

LOCK TABLE platform.oauth_resource_configuration IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE auth.oauth_clients IN SHARE ROW EXCLUSIVE MODE;

DO $preconditions$
DECLARE
  managed_metadata constant jsonb := jsonb_build_object(
    'alphanet_managed', true,
    'alphanet_provisioner', 'remote_mcp_oauth_clients_v1'
  );
  manifest_resource text;
BEGIN
  SELECT resource
  INTO STRICT manifest_resource
  FROM pg_temp.alphanet_remote_mcp_oauth_manifest;

  IF EXISTS (
    SELECT 1
    FROM platform.oauth_resource_configuration
    WHERE resource IS DISTINCT FROM manifest_resource
  ) THEN
    RAISE EXCEPTION 'Remote MCP OAuth resource does not match immutable configuration'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM auth.oauth_clients AS client
    JOIN pg_temp.alphanet_remote_mcp_oauth_manifest_clients AS desired
      ON desired.client_id = client.client_id
    WHERE client.metadata IS DISTINCT FROM managed_metadata
  ) THEN
    RAISE EXCEPTION 'OAuth client_id collides with an unmanaged client'
      USING ERRCODE = '23505';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM auth.oauth_clients AS client
    WHERE (
      client.metadata ? 'alphanet_managed'
      OR client.metadata ? 'alphanet_provisioner'
    )
      AND client.metadata IS DISTINCT FROM managed_metadata
  ) THEN
    RAISE EXCEPTION 'OAuth managed-client marker is partial or unreviewed'
      USING ERRCODE = '55000';
  END IF;
END;
$preconditions$;

INSERT INTO platform.oauth_resource_configuration (id, resource)
SELECT true, resource
FROM pg_temp.alphanet_remote_mcp_oauth_manifest
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.oauth_clients AS current_client (
  client_id,
  client_secret,
  disabled,
  skip_consent,
  enable_end_session,
  subject_type,
  scopes,
  user_id,
  created_at,
  updated_at,
  name,
  uri,
  icon,
  contacts,
  tos,
  policy,
  software_id,
  software_version,
  software_statement,
  redirect_uris,
  post_logout_redirect_uris,
  token_endpoint_auth_method,
  grant_types,
  response_types,
  public,
  type,
  require_pkce,
  reference_id,
  metadata
)
SELECT
  desired.client_id,
  NULL,
  false,
  false,
  false,
  NULL,
  desired.scopes,
  NULL,
  clock_timestamp(),
  clock_timestamp(),
  desired.name,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  desired.redirect_uris,
  NULL,
  'none',
  desired.grant_types,
  '["code"]'::jsonb,
  true,
  NULL,
  true,
  NULL,
  jsonb_build_object(
    'alphanet_managed', true,
    'alphanet_provisioner', 'remote_mcp_oauth_clients_v1'
  )
FROM pg_temp.alphanet_remote_mcp_oauth_manifest_clients AS desired
ON CONFLICT (client_id) DO UPDATE SET
  client_secret = NULL,
  disabled = false,
  skip_consent = false,
  enable_end_session = false,
  subject_type = NULL,
  scopes = EXCLUDED.scopes,
  user_id = NULL,
  updated_at = clock_timestamp(),
  name = EXCLUDED.name,
  uri = NULL,
  icon = NULL,
  contacts = NULL,
  tos = NULL,
  policy = NULL,
  software_id = NULL,
  software_version = NULL,
  software_statement = NULL,
  redirect_uris = EXCLUDED.redirect_uris,
  post_logout_redirect_uris = NULL,
  token_endpoint_auth_method = 'none',
  grant_types = EXCLUDED.grant_types,
  response_types = '["code"]'::jsonb,
  public = true,
  type = NULL,
  require_pkce = true,
  reference_id = NULL,
  metadata = EXCLUDED.metadata
WHERE current_client.metadata = EXCLUDED.metadata;

UPDATE auth.oauth_clients AS client
SET client_secret = NULL,
    disabled = true,
    skip_consent = false,
    enable_end_session = false,
    subject_type = NULL,
    user_id = NULL,
    updated_at = clock_timestamp(),
    uri = NULL,
    icon = NULL,
    contacts = NULL,
    tos = NULL,
    policy = NULL,
    software_id = NULL,
    software_version = NULL,
    software_statement = NULL,
    post_logout_redirect_uris = NULL,
    token_endpoint_auth_method = 'none',
    response_types = '["code"]'::jsonb,
    public = true,
    type = NULL,
    require_pkce = true,
    reference_id = NULL
WHERE client.metadata = jsonb_build_object(
    'alphanet_managed', true,
    'alphanet_provisioner', 'remote_mcp_oauth_clients_v1'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_temp.alphanet_remote_mcp_oauth_manifest_clients AS desired
    WHERE desired.client_id = client.client_id
  );

DO $verification$
DECLARE
  managed_metadata constant jsonb := jsonb_build_object(
    'alphanet_managed', true,
    'alphanet_provisioner', 'remote_mcp_oauth_clients_v1'
  );
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM platform.oauth_resource_configuration AS configured
    JOIN pg_temp.alphanet_remote_mcp_oauth_manifest AS desired
      ON desired.resource = configured.resource
    WHERE configured.id = true
  ) THEN
    RAISE EXCEPTION 'Remote MCP OAuth resource verification failed'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_temp.alphanet_remote_mcp_oauth_manifest_clients AS desired
    LEFT JOIN auth.oauth_clients AS actual
      ON actual.client_id = desired.client_id
    WHERE actual.client_id IS NULL
      OR actual.metadata IS DISTINCT FROM managed_metadata
      OR actual.disabled IS DISTINCT FROM false
      OR actual.skip_consent IS DISTINCT FROM false
      OR actual.require_pkce IS DISTINCT FROM true
      OR actual.enable_end_session IS DISTINCT FROM false
      OR actual.token_endpoint_auth_method IS DISTINCT FROM 'none'
      OR actual.public IS DISTINCT FROM true
      OR actual.client_secret IS NOT NULL
      OR actual.name IS DISTINCT FROM desired.name
      OR actual.redirect_uris IS DISTINCT FROM desired.redirect_uris
      OR actual.scopes IS DISTINCT FROM desired.scopes
      OR actual.grant_types IS DISTINCT FROM desired.grant_types
      OR actual.response_types IS DISTINCT FROM '["code"]'::jsonb
      OR actual.user_id IS NOT NULL
      OR actual.uri IS NOT NULL
      OR actual.icon IS NOT NULL
      OR actual.contacts IS NOT NULL
      OR actual.tos IS NOT NULL
      OR actual.policy IS NOT NULL
      OR actual.software_id IS NOT NULL
      OR actual.software_version IS NOT NULL
      OR actual.software_statement IS NOT NULL
      OR actual.post_logout_redirect_uris IS NOT NULL
      OR actual.type IS NOT NULL
      OR actual.reference_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Remote MCP OAuth client verification failed'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM auth.oauth_clients AS actual
    WHERE actual.metadata = managed_metadata
      AND (
        actual.skip_consent IS DISTINCT FROM false
        OR actual.require_pkce IS DISTINCT FROM true
        OR actual.enable_end_session IS DISTINCT FROM false
        OR actual.token_endpoint_auth_method IS DISTINCT FROM 'none'
        OR actual.public IS DISTINCT FROM true
        OR actual.client_secret IS NOT NULL
        OR actual.response_types IS DISTINCT FROM '["code"]'::jsonb
        OR actual.user_id IS NOT NULL
        OR actual.uri IS NOT NULL
        OR actual.icon IS NOT NULL
        OR actual.contacts IS NOT NULL
        OR actual.tos IS NOT NULL
        OR actual.policy IS NOT NULL
        OR actual.software_id IS NOT NULL
        OR actual.software_version IS NOT NULL
        OR actual.software_statement IS NOT NULL
        OR actual.post_logout_redirect_uris IS NOT NULL
        OR actual.type IS NOT NULL
        OR actual.reference_id IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'Remote MCP OAuth managed-client security verification failed'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM auth.oauth_clients AS actual
    WHERE actual.metadata = managed_metadata
      AND actual.disabled IS DISTINCT FROM NOT EXISTS (
        SELECT 1
        FROM pg_temp.alphanet_remote_mcp_oauth_manifest_clients AS desired
        WHERE desired.client_id = actual.client_id
      )
  ) THEN
    RAISE EXCEPTION 'Remote MCP OAuth omitted-client disable verification failed'
      USING ERRCODE = '55000';
  END IF;
END;
$verification$;

COMMIT;
