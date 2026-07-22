SET LOCAL search_path = pg_catalog;

-- A successful OAuth bootstrap crosses the Provider and AlphaNet authority
-- stores. The request boundary compensates synchronous failures, while this
-- immutable ledger lets a low-frequency Worker reconcile process crashes
-- without repeatedly scanning every historical Grant.
CREATE TABLE platform.oauth_grant_bootstrap_reconciliations (
  grant_id uuid PRIMARY KEY
    REFERENCES platform.oauth_grants(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  outcome text NOT NULL,
  reason_code text NOT NULL,
  reconciled_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT oauth_grant_bootstrap_reconciliations_outcome
    CHECK (outcome IN ('coherent', 'terminated')),
  CONSTRAINT oauth_grant_bootstrap_reconciliations_reason
    CHECK (reason_code ~ '^[a-z0-9][a-z0-9_.-]{0,119}$')
);

COMMENT ON TABLE platform.oauth_grant_bootstrap_reconciliations IS
  'Immutable, identifier-only audit ledger for one-time Remote MCP OAuth bootstrap reconciliation. It stores no token, code, PKCE, redirect, session, or credential material.';

CREATE FUNCTION platform.prevent_oauth_grant_bootstrap_reconciliation_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  grant_status text;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'oauth_grant_bootstrap_reconciliations' THEN
    RAISE EXCEPTION 'OAuth bootstrap reconciliation guard invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'OAuth bootstrap reconciliation audit is immutable'
      USING ERRCODE = '55000';
  END IF;

  SELECT oauth_grant.status
  INTO grant_status
  FROM platform.oauth_grants AS oauth_grant
  WHERE oauth_grant.id = NEW.grant_id
  FOR SHARE;

  IF NOT FOUND
    OR (NEW.outcome = 'coherent' AND grant_status <> 'active')
    OR (
      NEW.outcome = 'terminated'
      AND grant_status NOT IN ('expired', 'revoked', 'compromised')
    ) THEN
    RAISE EXCEPTION 'OAuth bootstrap reconciliation outcome does not match Grant state'
      USING ERRCODE = '23514';
  END IF;

  NEW.reconciled_at := statement_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER oauth_grant_bootstrap_reconciliations_guard
BEFORE INSERT OR UPDATE OR DELETE
ON platform.oauth_grant_bootstrap_reconciliations
FOR EACH ROW
EXECUTE FUNCTION platform.prevent_oauth_grant_bootstrap_reconciliation_mutation();

REVOKE ALL ON FUNCTION
  platform.prevent_oauth_grant_bootstrap_reconciliation_mutation()
FROM PUBLIC;

-- This closed queue is the local, indexed unreconciled marker. It is populated
-- for existing current Grants during migration and by a trigger for each new
-- Grant. Terminal transitions remove their row atomically; coherent Worker
-- reconciliation removes it after writing the immutable ledger. Candidate
-- discovery is therefore proportional to unresolved bootstraps, never the
-- long-lived historical active-Grant population.
CREATE TABLE system.oauth_grant_bootstrap_queue (
  grant_id uuid PRIMARY KEY
    REFERENCES platform.oauth_grants(id)
    ON UPDATE RESTRICT
    ON DELETE CASCADE,
  enqueued_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

COMMENT ON TABLE system.oauth_grant_bootstrap_queue IS
  'Closed, identifier-only queue of current OAuth Grants whose Provider/domain bootstrap has not yet received a terminal reconciliation decision.';

CREATE INDEX oauth_grant_bootstrap_queue_order_idx
  ON system.oauth_grant_bootstrap_queue (enqueued_at, grant_id);

INSERT INTO system.oauth_grant_bootstrap_queue (grant_id, enqueued_at)
SELECT oauth_grant.id, oauth_grant.consented_at
FROM platform.oauth_grants AS oauth_grant
WHERE oauth_grant.status IN ('pending', 'active')
ORDER BY oauth_grant.consented_at, oauth_grant.id;

CREATE FUNCTION platform.maintain_oauth_grant_bootstrap_queue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'oauth_grants'
    OR TG_OP NOT IN ('INSERT', 'UPDATE') THEN
    RAISE EXCEPTION 'OAuth bootstrap queue trigger invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'OAuth bootstrap queue accepts only pending Grant inserts'
        USING ERRCODE = '23514';
    END IF;
    INSERT INTO system.oauth_grant_bootstrap_queue (grant_id, enqueued_at)
    VALUES (NEW.id, NEW.consented_at);
  ELSIF OLD.status IN ('pending', 'active')
    AND NEW.status IN ('expired', 'revoked', 'compromised') THEN
    DELETE FROM system.oauth_grant_bootstrap_queue AS bootstrap_queue
    WHERE bootstrap_queue.grant_id = NEW.id;
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER oauth_grants_maintain_bootstrap_queue
AFTER INSERT OR UPDATE OF status ON platform.oauth_grants
FOR EACH ROW
EXECUTE FUNCTION platform.maintain_oauth_grant_bootstrap_queue();

REVOKE ALL ON FUNCTION platform.maintain_oauth_grant_bootstrap_queue()
FROM PUBLIC;

-- The Provider access-token index makes family cleanup proportional to the
-- selected Grant instead of the global Provider table.

CREATE INDEX oauth_authorization_requests_terminal_retention_idx
  ON platform.oauth_authorization_requests (terminal_at, id)
  WHERE status IN ('denied', 'expired') AND grant_id IS NULL;

CREATE INDEX oauth_access_tokens_grant_reference_idx
  ON auth.oauth_access_tokens (reference_id, client_id, user_id, id)
  WHERE reference_id IS NOT NULL;

-- Emit bounded, aggregate-only gauges before each drain. Counts are capped so
-- observability cannot turn an incident backlog into an unbounded COUNT scan;
-- reaching the cap is surfaced separately by the Worker. Oldest age is the
-- time since a row became eligible, not its creation time.
CREATE FUNCTION system.inspect_remote_mcp_oauth_lifecycle_backlog(
  candidate_grace_seconds integer,
  candidate_retention_seconds integer,
  candidate_count_cap integer
)
RETURNS TABLE (
  expired_envelope_count integer,
  expired_envelope_oldest_age_seconds integer,
  unreconciled_grant_count integer,
  unreconciled_grant_oldest_age_seconds integer,
  purgeable_envelope_count integer,
  purgeable_envelope_oldest_age_seconds integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF candidate_grace_seconds IS NULL
    OR candidate_grace_seconds NOT BETWEEN 0 AND 600 THEN
    RAISE EXCEPTION 'OAuth backlog grace must be from 0 through 600 seconds'
      USING ERRCODE = '22023';
  END IF;
  IF candidate_retention_seconds IS NULL
    OR candidate_retention_seconds NOT BETWEEN 86400 AND 7776000 THEN
    RAISE EXCEPTION 'OAuth backlog retention must be from 1 through 90 days'
      USING ERRCODE = '22023';
  END IF;
  IF candidate_count_cap IS NULL
    OR candidate_count_cap NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'OAuth backlog count cap must be from 1 through 100000'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH expired_candidates AS MATERIALIZED (
    SELECT authorization_request.id,
           authorization_request.expires_at AS eligible_at
    FROM platform.oauth_authorization_requests AS authorization_request
    WHERE authorization_request.status IN ('pending', 'selected')
      AND authorization_request.expires_at <= statement_timestamp()
    ORDER BY authorization_request.expires_at, authorization_request.id
    LIMIT candidate_count_cap
  ), pending_unreconciled_candidates AS MATERIALIZED (
    SELECT oauth_grant.id,
           CASE
             WHEN authorization_request.status IN ('denied', 'expired')
               THEN coalesce(
                 authorization_request.terminal_at,
                 authorization_request.expires_at
               )
             ELSE authorization_request.expires_at
           END AS eligible_at
    FROM system.oauth_grant_bootstrap_queue AS bootstrap_queue
    INNER JOIN platform.oauth_grants AS oauth_grant
      ON oauth_grant.id = bootstrap_queue.grant_id
    INNER JOIN platform.oauth_authorization_requests AS authorization_request
      ON authorization_request.id = oauth_grant.authorization_request_id
     AND authorization_request.owner_id = oauth_grant.owner_id
     AND authorization_request.agent_id = oauth_grant.agent_id
    WHERE oauth_grant.status = 'pending'
      AND (
        authorization_request.status IN ('denied', 'expired')
        OR authorization_request.expires_at <= statement_timestamp()
      )
    ORDER BY eligible_at, bootstrap_queue.enqueued_at, oauth_grant.id
    LIMIT candidate_count_cap
  ), active_unreconciled_candidates AS MATERIALIZED (
    SELECT oauth_grant.id,
           oauth_grant.activated_at
             + pg_catalog.make_interval(secs => candidate_grace_seconds)
             AS eligible_at
    FROM system.oauth_grant_bootstrap_queue AS bootstrap_queue
    INNER JOIN platform.oauth_grants AS oauth_grant
      ON oauth_grant.id = bootstrap_queue.grant_id
    WHERE oauth_grant.status = 'active'
      AND oauth_grant.activated_at <= statement_timestamp()
        - pg_catalog.make_interval(secs => candidate_grace_seconds)
    ORDER BY oauth_grant.activated_at, bootstrap_queue.enqueued_at, oauth_grant.id
    LIMIT candidate_count_cap
  ), unreconciled_candidates AS MATERIALIZED (
    SELECT candidate.id, candidate.eligible_at
    FROM (
      SELECT pending_candidate.id, pending_candidate.eligible_at
      FROM pending_unreconciled_candidates AS pending_candidate
      UNION ALL
      SELECT active_candidate.id, active_candidate.eligible_at
      FROM active_unreconciled_candidates AS active_candidate
    ) AS candidate
    ORDER BY candidate.eligible_at, candidate.id
    LIMIT candidate_count_cap
  ), purgeable_candidates AS MATERIALIZED (
    SELECT authorization_request.id,
           authorization_request.terminal_at
             + pg_catalog.make_interval(secs => candidate_retention_seconds)
             AS eligible_at
    FROM platform.oauth_authorization_requests AS authorization_request
    WHERE authorization_request.status IN ('denied', 'expired')
      AND authorization_request.grant_id IS NULL
      AND authorization_request.terminal_at < statement_timestamp()
        - pg_catalog.make_interval(secs => candidate_retention_seconds)
      AND NOT EXISTS (
        SELECT 1
        FROM platform.oauth_grants AS oauth_grant
        WHERE oauth_grant.authorization_request_id = authorization_request.id
      )
    ORDER BY authorization_request.terminal_at, authorization_request.id
    LIMIT candidate_count_cap
  ), expired_stats AS (
    SELECT count(*)::integer AS candidate_count,
           CASE WHEN min(eligible_at) IS NULL THEN NULL ELSE
             least(
               2147483647::numeric,
               greatest(
                 0::numeric,
                 floor(extract(epoch FROM (
                   statement_timestamp() - min(eligible_at)
                 )))
               )
             )::integer
           END AS oldest_age_seconds
    FROM expired_candidates
  ), unreconciled_stats AS (
    SELECT count(*)::integer AS candidate_count,
           CASE WHEN min(eligible_at) IS NULL THEN NULL ELSE
             least(
               2147483647::numeric,
               greatest(
                 0::numeric,
                 floor(extract(epoch FROM (
                   statement_timestamp() - min(eligible_at)
                 )))
               )
             )::integer
           END AS oldest_age_seconds
    FROM unreconciled_candidates
  ), purgeable_stats AS (
    SELECT count(*)::integer AS candidate_count,
           CASE WHEN min(eligible_at) IS NULL THEN NULL ELSE
             least(
               2147483647::numeric,
               greatest(
                 0::numeric,
                 floor(extract(epoch FROM (
                   statement_timestamp() - min(eligible_at)
                 )))
               )
             )::integer
           END AS oldest_age_seconds
    FROM purgeable_candidates
  )
  SELECT expired_stats.candidate_count,
         expired_stats.oldest_age_seconds,
         unreconciled_stats.candidate_count,
         unreconciled_stats.oldest_age_seconds,
         purgeable_stats.candidate_count,
         purgeable_stats.oldest_age_seconds
  FROM expired_stats
  CROSS JOIN unreconciled_stats
  CROSS JOIN purgeable_stats;
END;
$$;

REVOKE ALL ON FUNCTION
  system.inspect_remote_mcp_oauth_lifecycle_backlog(integer, integer, integer)
FROM PUBLIC;

-- Terminalize expired one-shot envelopes before retention considers them.
-- SKIP LOCKED allows multiple Worker replicas to make progress without two
-- replicas updating the same immutable lifecycle row.
CREATE FUNCTION system.expire_remote_mcp_oauth_authorization_requests(
  candidate_batch_size integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  expired_count integer;
BEGIN
  IF candidate_batch_size IS NULL
    OR candidate_batch_size NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'OAuth envelope expiry batch size must be from 1 through 1000'
      USING ERRCODE = '22023';
  END IF;

  WITH candidates AS MATERIALIZED (
    SELECT authorization_request.id
    FROM platform.oauth_authorization_requests AS authorization_request
    WHERE authorization_request.status IN ('pending', 'selected')
      AND authorization_request.expires_at <= statement_timestamp()
    ORDER BY authorization_request.expires_at, authorization_request.id
    FOR UPDATE SKIP LOCKED
    LIMIT candidate_batch_size
  )
  UPDATE platform.oauth_authorization_requests AS authorization_request
  SET status = 'expired'
  FROM candidates
  WHERE authorization_request.id = candidates.id
    AND authorization_request.status IN ('pending', 'selected');

  GET DIAGNOSTICS expired_count = ROW_COUNT;
  RETURN expired_count;
END;
$$;

REVOKE ALL ON FUNCTION
  system.expire_remote_mcp_oauth_authorization_requests(integer)
FROM PUBLIC;

-- Reconcile the two crash windows that cannot be made one PostgreSQL
-- transaction with the Provider: abandoned pending authorization-code Grants,
-- and active Grants for which the initial Provider/JTI authority set never
-- became coherent. Every inconsistent family is terminated fail closed in the
-- same transaction as its immutable reconciliation record.
CREATE FUNCTION system.reconcile_remote_mcp_oauth_grant_bootstraps(
  candidate_batch_size integer,
  candidate_grace_seconds integer
)
RETURNS TABLE (
  inspected_count integer,
  coherent_count integer,
  terminated_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  candidate record;
  expected_provider_scopes jsonb;
  has_consent boolean;
  has_refresh boolean;
  has_token_pair boolean;
  principal_is_live boolean;
  reconciliation_reason text;
BEGIN
  IF candidate_batch_size IS NULL
    OR candidate_batch_size NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'OAuth bootstrap reconciliation batch size must be from 1 through 1000'
      USING ERRCODE = '22023';
  END IF;
  IF candidate_grace_seconds IS NULL
    OR candidate_grace_seconds NOT BETWEEN 0 AND 600 THEN
    RAISE EXCEPTION 'OAuth bootstrap reconciliation grace must be from 0 through 600 seconds'
      USING ERRCODE = '22023';
  END IF;

  inspected_count := 0;
  coherent_count := 0;
  terminated_count := 0;

  FOR candidate IN
    SELECT
      oauth_grant.id,
      oauth_grant.owner_id,
      oauth_grant.auth_user_id,
      oauth_grant.agent_id,
      oauth_grant.credential_id,
      oauth_grant.authorization_request_id,
      oauth_grant.oauth_client_id,
      oauth_grant.resource,
      oauth_grant.scopes,
      oauth_grant.offline_access,
      oauth_grant.status,
      oauth_grant.token_epoch,
      oauth_grant.consented_at,
      oauth_grant.activated_at,
      oauth_grant.expires_at,
      authorization_request.status AS request_status,
      authorization_request.grant_id AS request_grant_id,
      authorization_request.redirect_uri AS request_redirect_uri,
      authorization_request.expires_at AS request_expires_at,
      credential.revoked_at AS credential_revoked_at
    FROM system.oauth_grant_bootstrap_queue AS bootstrap_queue
    INNER JOIN platform.oauth_grants AS oauth_grant
      ON oauth_grant.id = bootstrap_queue.grant_id
    INNER JOIN platform.oauth_authorization_requests AS authorization_request
      ON authorization_request.id = oauth_grant.authorization_request_id
     AND authorization_request.owner_id = oauth_grant.owner_id
     AND authorization_request.agent_id = oauth_grant.agent_id
    INNER JOIN platform.credentials AS credential
      ON credential.id = oauth_grant.credential_id
     AND credential.owner_id = oauth_grant.owner_id
     AND credential.agent_id = oauth_grant.agent_id
    WHERE (
        (
          oauth_grant.status = 'pending'
          AND (
            authorization_request.status IN ('denied', 'expired')
            OR authorization_request.expires_at <= statement_timestamp()
          )
        )
        OR (
          oauth_grant.status = 'active'
          AND oauth_grant.activated_at <= statement_timestamp()
            - pg_catalog.make_interval(secs => candidate_grace_seconds)
        )
      )
    ORDER BY
      CASE WHEN oauth_grant.status = 'pending' THEN 0 ELSE 1 END,
      coalesce(oauth_grant.activated_at, authorization_request.expires_at),
      oauth_grant.id
    FOR UPDATE OF bootstrap_queue, oauth_grant, authorization_request, credential
      SKIP LOCKED
    LIMIT candidate_batch_size
  LOOP
    inspected_count := inspected_count + 1;

    IF candidate.status = 'pending' THEN
      IF candidate.request_status IN ('pending', 'selected')
        AND candidate.request_expires_at <= statement_timestamp() THEN
        UPDATE platform.oauth_authorization_requests AS authorization_request
        SET status = 'expired'
        WHERE authorization_request.id = candidate.authorization_request_id
          AND authorization_request.status IN ('pending', 'selected');
      END IF;

      reconciliation_reason := CASE
        WHEN candidate.request_status = 'consumed'
          THEN 'authorization_code_abandoned'
        WHEN candidate.request_status = 'denied'
          THEN 'authorization_request_denied'
        ELSE 'authorization_request_expired'
      END;
    ELSE
      expected_provider_scopes := pg_catalog.to_jsonb(
        CASE
          WHEN candidate.offline_access
            THEN candidate.scopes || 'offline_access'::text
          ELSE candidate.scopes
        END
      );

      SELECT EXISTS (
        SELECT 1
        FROM auth.oauth_consents AS provider_consent
        WHERE provider_consent.reference_id = candidate.id::text
          AND provider_consent.client_id = candidate.oauth_client_id
          AND provider_consent.user_id = candidate.auth_user_id
          AND provider_consent.scopes @> expected_provider_scopes
          AND expected_provider_scopes @> provider_consent.scopes
      )
      INTO has_consent;

      SELECT CASE
        WHEN candidate.offline_access THEN EXISTS (
          SELECT 1
          FROM auth.oauth_refresh_tokens AS refresh_token
          WHERE refresh_token.reference_id = candidate.id::text
            AND refresh_token.client_id = candidate.oauth_client_id
            AND refresh_token.user_id = candidate.auth_user_id
            AND refresh_token.revoked IS NULL
            AND refresh_token.expires_at <= candidate.expires_at
            AND refresh_token.scopes @> expected_provider_scopes
            AND expected_provider_scopes @> refresh_token.scopes
        )
        ELSE NOT EXISTS (
          SELECT 1
          FROM auth.oauth_refresh_tokens AS refresh_token
          WHERE refresh_token.reference_id = candidate.id::text
        )
      END
      INTO has_refresh;

      SELECT EXISTS (
        SELECT 1
        FROM auth.oauth_access_tokens AS access_token
        INNER JOIN platform.oauth_access_token_jtis AS token_jti
          ON token_jti.grant_id = candidate.id
         AND token_jti.owner_id = candidate.owner_id
         AND token_jti.agent_id = candidate.agent_id
         AND token_jti.grant_epoch = candidate.token_epoch
         AND token_jti.oauth_client_id = candidate.oauth_client_id
         AND token_jti.resource = candidate.resource
         AND platform.oauth_text_arrays_are_same_set(
           token_jti.scopes,
           candidate.scopes
         )
         AND pg_catalog.abs(
           extract(epoch FROM access_token.created_at - token_jti.issued_at)
         ) <= 5
         AND pg_catalog.abs(
           extract(epoch FROM access_token.expires_at - token_jti.expires_at)
         ) <= 1
        WHERE access_token.reference_id = candidate.id::text
          AND access_token.client_id = candidate.oauth_client_id
          AND access_token.user_id = candidate.auth_user_id
          AND access_token.created_at >= candidate.consented_at - interval '5 seconds'
          AND access_token.expires_at <= candidate.expires_at
          AND access_token.scopes @> expected_provider_scopes
          AND expected_provider_scopes @> access_token.scopes
      )
      INTO has_token_pair;

      SELECT EXISTS (
        SELECT 1
        FROM platform.owners AS owner
        INNER JOIN auth.users AS auth_user
          ON auth_user.id = owner.auth_user_id
         AND auth_user.email_verified
        INNER JOIN platform.agents AS agent
          ON agent.id = candidate.agent_id
         AND agent.owner_id = owner.id
         AND agent.status = 'active'
         AND agent.deleted_at IS NULL
        INNER JOIN platform.actors AS actor
          ON actor.id = agent.actor_id
         AND actor.owner_id = owner.id
         AND actor.kind = 'agent'
         AND actor.status = 'active'
         AND actor.deleted_at IS NULL
        INNER JOIN auth.oauth_clients AS oauth_client
          ON oauth_client.client_id = candidate.oauth_client_id
         AND oauth_client.disabled = false
         AND oauth_client.skip_consent = false
         AND oauth_client.require_pkce = true
         AND oauth_client.token_endpoint_auth_method = 'none'
         AND oauth_client.public = true
         AND oauth_client.client_secret IS NULL
         AND oauth_client.redirect_uris ? candidate.request_redirect_uri
         AND oauth_client.scopes @> expected_provider_scopes
         AND oauth_client.grant_types ? 'authorization_code'
         AND (
           NOT candidate.offline_access
           OR oauth_client.grant_types ? 'refresh_token'
         )
        WHERE owner.id = candidate.owner_id
          AND owner.auth_user_id = candidate.auth_user_id
          AND owner.status = 'active'
          AND owner.email_verified_at IS NOT NULL
          AND owner.deleted_at IS NULL
      )
      INTO principal_is_live;

      IF candidate.request_status = 'consumed'
        AND candidate.request_grant_id = candidate.id
        AND candidate.credential_revoked_at IS NULL
        AND has_consent
        AND has_refresh
        AND has_token_pair
        AND principal_is_live THEN
        INSERT INTO platform.oauth_grant_bootstrap_reconciliations (
          grant_id,
          outcome,
          reason_code
        )
        VALUES (candidate.id, 'coherent', 'authority_complete');
        DELETE FROM system.oauth_grant_bootstrap_queue AS bootstrap_queue
        WHERE bootstrap_queue.grant_id = candidate.id;
        coherent_count := coherent_count + 1;
        CONTINUE;
      END IF;

      reconciliation_reason := 'oauth_bootstrap_incomplete';
    END IF;

    -- This ordering mirrors the synchronous compensation boundary. The Grant
    -- row lock serializes Provider insert triggers; any waiter observes the
    -- terminal Grant/Credential after commit and fails closed.
    UPDATE auth.oauth_refresh_tokens AS refresh_token
    SET revoked = greatest(statement_timestamp(), refresh_token.created_at)
    WHERE refresh_token.reference_id = candidate.id::text
      AND refresh_token.client_id = candidate.oauth_client_id
      AND refresh_token.user_id = candidate.auth_user_id
      AND refresh_token.revoked IS NULL;

    DELETE FROM auth.oauth_access_tokens AS access_token
    WHERE access_token.reference_id = candidate.id::text
      AND access_token.client_id = candidate.oauth_client_id
      AND access_token.user_id = candidate.auth_user_id;

    DELETE FROM auth.oauth_consents AS provider_consent
    WHERE provider_consent.reference_id = candidate.id::text
      AND provider_consent.client_id = candidate.oauth_client_id
      AND provider_consent.user_id = candidate.auth_user_id;

    UPDATE platform.oauth_access_token_jtis AS token_jti
    SET status = 'revoked',
        revoked_at = greatest(statement_timestamp(), token_jti.issued_at),
        revocation_reason_code = 'oauth_bootstrap_reconciled'
    WHERE token_jti.grant_id = candidate.id
      AND token_jti.status = 'active';

    UPDATE platform.credentials AS credential
    SET revoked_at = greatest(statement_timestamp(), credential.issued_at)
    WHERE credential.id = candidate.credential_id
      AND credential.revoked_at IS NULL;

    IF candidate.status = 'pending'
      AND candidate.request_status <> 'consumed' THEN
      UPDATE platform.oauth_grants AS oauth_grant
      SET status = 'expired',
          reason_code = reconciliation_reason
      WHERE oauth_grant.id = candidate.id
        AND oauth_grant.status = 'pending';
    ELSE
      UPDATE platform.oauth_grants AS oauth_grant
      SET status = 'compromised',
          token_epoch = oauth_grant.token_epoch + 1,
          reason_code = reconciliation_reason
      WHERE oauth_grant.id = candidate.id
        AND oauth_grant.status IN ('pending', 'active');
    END IF;

    INSERT INTO platform.oauth_grant_bootstrap_reconciliations (
      grant_id,
      outcome,
      reason_code
    )
    VALUES (candidate.id, 'terminated', reconciliation_reason);
    DELETE FROM system.oauth_grant_bootstrap_queue AS bootstrap_queue
    WHERE bootstrap_queue.grant_id = candidate.id;
    terminated_count := terminated_count + 1;
  END LOOP;

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION
  system.reconcile_remote_mcp_oauth_grant_bootstraps(integer, integer)
FROM PUBLIC;

-- Only terminal envelopes without any Grant reference are eligible. A Grant
-- preserves both FK directions of the authorization audit chain indefinitely.
CREATE FUNCTION system.purge_terminal_remote_mcp_oauth_authorization_requests(
  candidate_batch_size integer,
  candidate_retention_seconds integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  purged_count integer;
BEGIN
  IF candidate_batch_size IS NULL
    OR candidate_batch_size NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'OAuth envelope purge batch size must be from 1 through 1000'
      USING ERRCODE = '22023';
  END IF;
  IF candidate_retention_seconds IS NULL
    OR candidate_retention_seconds NOT BETWEEN 86400 AND 7776000 THEN
    RAISE EXCEPTION 'OAuth envelope retention must be from 1 through 90 days'
      USING ERRCODE = '22023';
  END IF;

  WITH candidates AS MATERIALIZED (
    SELECT authorization_request.id
    FROM platform.oauth_authorization_requests AS authorization_request
    WHERE authorization_request.status IN ('denied', 'expired')
      AND authorization_request.grant_id IS NULL
      AND authorization_request.terminal_at < statement_timestamp()
        - pg_catalog.make_interval(secs => candidate_retention_seconds)
      AND NOT EXISTS (
        SELECT 1
        FROM platform.oauth_grants AS oauth_grant
        WHERE oauth_grant.authorization_request_id = authorization_request.id
      )
    ORDER BY authorization_request.terminal_at, authorization_request.id
    FOR UPDATE SKIP LOCKED
    LIMIT candidate_batch_size
  )
  DELETE FROM platform.oauth_authorization_requests AS authorization_request
  USING candidates
  WHERE authorization_request.id = candidates.id;

  GET DIAGNOSTICS purged_count = ROW_COUNT;
  RETURN purged_count;
END;
$$;

REVOKE ALL ON FUNCTION
  system.purge_terminal_remote_mcp_oauth_authorization_requests(integer, integer)
FROM PUBLIC;
