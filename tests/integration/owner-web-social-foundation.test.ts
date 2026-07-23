import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import {
  closeDependencies,
  createPostgresDependency,
  type HealthDependency,
} from "../../packages/database/src/index.js";
import { PostgresAgentConnectionService } from "../../packages/domain/src/agent-connection.js";
import {
  OwnerSocialIdentityError,
  PostgresOwnerSocialIdentityService,
  type EnableHumanProfileInput,
  type UpdateHumanProfileInput,
} from "../../packages/domain/src/owner-social-identity.js";
import {
  createOwnerWebContextAuthority,
  OwnerWebSessionContextError,
  type OwnerWebMutationContext,
  type OwnerWebSessionContext,
} from "../../packages/domain/src/owner-web-session-context.js";
import { OWNER_WEB_SOCIAL_V1_MIGRATION_CHECKSUM } from "../../packages/domain/src/schema-migrations.js";
import {
  evaluateOwnerDirectOperation,
  PostgresWebSocialAuthorityResolver,
  WebSocialAuthorityError,
} from "../../packages/domain/src/web-social-authority.js";

const databaseUrl = process.env.DATABASE_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";

if (mustRun && !databaseUrl) {
  throw new Error("DATABASE_URL is required when REQUIRE_INTEGRATION_SERVICES=true");
}

const describeOwnerWebSocialFoundation = databaseUrl ? describe : describe.skip;
const dependencies: HealthDependency[] = [];

const agentConnectionOptions = {
  activeCredentialsPerAgent: 5,
  activeCredentialsPerOwner: 20,
  apiAudience: "urn:alphanet:api:v1",
  apiKeyCurrentPepperVersion: 1,
  apiKeyPeppers: {
    1: "owner-web-social-foundation-pepper-with-more-than-thirty-two-characters",
  },
  credentialDefaultTtlDays: 90,
  credentialIssuePerOwner24Hours: 10,
  credentialMaxTtlDays: 365,
  credentialMutationCooldownSeconds: 0,
} as const;

interface OwnerFixture {
  authenticatedAt: Date;
  email: string;
  ownerId: string;
  sessionId: string;
  sessionToken: string;
}

type AuthoritySelectionFixture =
  | Readonly<{ agentId: string; kind: "owner_direct" }>
  | Readonly<{ actorId: string; kind: "human_direct" }>;

interface HumanLifecycleEffectRow {
  action: string;
  actor_id: string | null;
  actor_kind: string | null;
  after_state: unknown;
  approval_method: string | null;
  approved_by_owner_id: string | null;
  authentication_assurance: string | null;
  authorization_snapshot: unknown;
  before_state: unknown;
  channel: string;
  credential_id: string | null;
  decision: string | null;
  event_aggregate_id: string;
  event_aggregate_type: string;
  event_payload: unknown;
  event_type: string;
  event_version: number;
  json_is_secret_free: boolean;
  log_owner_id: string | null;
  outcome: string;
  policy_version: string | null;
  request_id: string | null;
  target_id: string | null;
  target_type: string | null;
}

function marker(): string {
  return randomUUID().replaceAll("-", "").slice(0, 18);
}

function handle(prefix: string): string {
  return `${prefix}-${marker().slice(0, 32 - prefix.length - 1)}`;
}

function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`${label} was not created`);
  }
  return value;
}

describeOwnerWebSocialFoundation("Owner Web social PostgreSQL foundation", () => {
  const postgres = createPostgresDependency(databaseUrl ?? "");
  const competingPostgres = createPostgresDependency(databaseUrl ?? "");
  const contextAuthority = createOwnerWebContextAuthority();
  const identityService = new PostgresOwnerSocialIdentityService(postgres.sql, {
    contextVerifier: contextAuthority.verifier,
  });
  const authorityResolver = new PostgresWebSocialAuthorityResolver(
    postgres.sql,
    contextAuthority.verifier,
  );
  const agentService = new PostgresAgentConnectionService(
    postgres.sql,
    agentConnectionOptions,
  );
  dependencies.push(postgres, competingPostgres);

  async function createOwner(input: {
    label: string;
    verified?: boolean;
  }): Promise<OwnerFixture> {
    const userId = randomUUID();
    const email = `web-social-${input.label}-${marker()}@private.example.test`;
    await postgres.sql`
        insert into auth.users (
          id,
          name,
          email,
          email_verified,
          created_at,
          updated_at
        )
        values (
          ${userId},
          ${`Web Social ${input.label}`},
          ${email},
          ${input.verified ?? true},
          clock_timestamp(),
          clock_timestamp()
        )
      `;
    const owners = await postgres.sql<{ id: string }[]>`
        select id::text as id
        from platform.owners
        where auth_user_id = ${userId}
      `;
    const sessionId = randomUUID();
    const sessionToken = `web-social-session-${marker()}-${randomUUID()}`;
    const sessions = await postgres.sql<{ created_at: Date }[]>`
      with session_time as (
        select clock_timestamp() as created_at
      )
      insert into auth.sessions (
        id,
        expires_at,
        token,
        created_at,
        updated_at,
        user_id
      )
      select
        ${sessionId},
        session_time.created_at + interval '1 hour',
        ${sessionToken},
        session_time.created_at,
        session_time.created_at,
        ${userId}
      from session_time
      returning created_at
    `;
    return {
      authenticatedAt: requireValue(
        sessions[0]?.created_at,
        `${input.label} Owner session time`,
      ),
      email,
      ownerId: requireValue(owners[0]?.id, `${input.label} Owner`),
      sessionId,
      sessionToken,
    };
  }

  async function createAgent(ownerId: string, label: string) {
    return agentService.createAgent(
      ownerId,
      {
        bio: `${label} public biography`,
        discoveryTags: ["semiconductors", "risk"],
        displayName: `${label} Agent`,
        handle: handle(`agent-${label.toLowerCase()}`),
      },
      randomUUID(),
    );
  }

  function ownerWebSession(
    owner: OwnerFixture,
    requestId = randomUUID(),
  ): OwnerWebSessionContext {
    return contextAuthority.issuer.issueSessionContext({
      authenticatedAt: new Date(owner.authenticatedAt.valueOf()),
      authenticationAssurance: "owner_session",
      ownerId: owner.ownerId,
      requestId,
      sessionId: owner.sessionId,
    });
  }

  function ownerWebMutation(
    owner: OwnerFixture,
    requestId = randomUUID(),
  ): OwnerWebMutationContext {
    return contextAuthority.issuer.issueMutationContext({
      authenticatedAt: new Date(owner.authenticatedAt.valueOf()),
      authenticationAssurance: "owner_session",
      ownerId: owner.ownerId,
      requestId,
      sessionId: owner.sessionId,
    });
  }

  async function enableHumanProfile(
    context: OwnerWebMutationContext,
    input: EnableHumanProfileInput,
  ) {
    return identityService.enableHumanProfile(context, input);
  }

  async function updateHumanProfile(
    context: OwnerWebMutationContext,
    input: UpdateHumanProfileInput,
  ) {
    return identityService.updateHumanProfile(context, input);
  }

  async function listOwnerPublicIdentities(context: OwnerWebSessionContext) {
    return identityService.listOwnerPublicIdentities(context);
  }

  async function resolveAuthorityInWriteTransaction(
    context: OwnerWebMutationContext,
    selection: AuthoritySelectionFixture,
  ) {
    return postgres.sql.begin((transaction) =>
      authorityResolver.resolveAuthorityInTransaction(transaction, context, selection),
    );
  }

  async function expectIdentityError(
    promise: Promise<unknown>,
    code:
      | "HUMAN_PROFILE_ALREADY_ENABLED"
      | "HUMAN_PROFILE_HANDLE_TAKEN"
      | "OWNER_EMAIL_VERIFICATION_REQUIRED"
      | "OWNER_NOT_ACTIVE",
  ): Promise<void> {
    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OwnerSocialIdentityError);
    expect(error).toMatchObject({ code });
  }

  async function expectAuthorityError(
    context: OwnerWebMutationContext,
    selection: AuthoritySelectionFixture,
    code: "AUTHORITY_NOT_FOUND" | "OWNER_NOT_ELIGIBLE",
  ): Promise<void> {
    const error = await resolveAuthorityInWriteTransaction(context, selection).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(WebSocialAuthorityError);
    expect(error).toMatchObject({ code });
  }

  async function expectLockTimeout(work: Promise<unknown>): Promise<void> {
    const error = await work.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "55P03" });
  }

  afterAll(async () => {
    await closeDependencies(dependencies);
  });

  it("pins both services to the fresh 000021 schema", async () => {
    await expect(identityService.checkReady()).resolves.toBeUndefined();
    await expect(authorityResolver.checkReady()).resolves.toBeUndefined();

    const migrations = await postgres.sql<
      { checksum: string; name: string; version: string }[]
    >`
        select version, name, checksum
        from system.schema_migrations
        where version = '000021'
      `;
    expect(migrations).toEqual([
      {
        checksum: OWNER_WEB_SOCIAL_V1_MIGRATION_CHECKSUM,
        name: "owner_web_social_v1",
        version: "000021",
      },
    ]);
  });

  it("fails readiness closed when a required enforcement trigger is disabled", async () => {
    await postgres.sql`
        alter table platform.actors
        disable trigger actors_prepare_update
      `;
    try {
      await expect(identityService.checkReady()).rejects.toThrow(
        "Owner social identity schema is not ready",
      );
    } finally {
      await postgres.sql`
          alter table platform.actors
          enable trigger actors_prepare_update
        `;
    }

    await postgres.sql`
        alter table platform.action_logs
        disable trigger action_logs_validate_domain_write_subject
      `;
    try {
      await expect(authorityResolver.checkReady()).rejects.toMatchObject({
        code: "SCHEMA_NOT_READY",
      });
    } finally {
      await postgres.sql`
          alter table platform.action_logs
          enable trigger action_logs_validate_domain_write_subject
        `;
    }

    await postgres.sql`
        alter table platform.content_items
        disable trigger content_items_validate_runtime_provenance
      `;
    try {
      await expect(authorityResolver.checkReady()).rejects.toMatchObject({
        code: "SCHEMA_NOT_READY",
      });
    } finally {
      await postgres.sql`
          alter table platform.content_items
          enable trigger content_items_validate_runtime_provenance
        `;
    }

    await expect(identityService.checkReady()).resolves.toBeUndefined();
    await expect(authorityResolver.checkReady()).resolves.toBeUndefined();
  });

  it("enables and updates one immutable-handle human profile idempotently with strict effects", async () => {
    const owner = await createOwner({ label: "lifecycle" });
    const enableRequestId = randomUUID();
    const noOpRequestId = randomUUID();
    const conflictRequestId = randomUUID();
    const updateRequestId = randomUUID();
    const enableContext = ownerWebMutation(owner, enableRequestId);
    const noOpContext = ownerWebMutation(owner, noOpRequestId);
    const conflictContext = ownerWebMutation(owner, conflictRequestId);
    const updateContext = ownerWebMutation(owner, updateRequestId);
    const profileHandle = handle("human-lifecycle");
    const initialInput = {
      bio: "Cross-validates semiconductor research.",
      displayName: "Lifecycle Researcher",
      handle: profileHandle,
    };

    const enabled = await enableHumanProfile(enableContext, initialInput);
    expect(enabled).toMatchObject({
      changed: true,
      profile: {
        agentId: null,
        bio: initialInput.bio,
        displayName: initialInput.displayName,
        handle: profileHandle,
        kind: "human",
        status: "active",
      },
    });

    await expect(enableHumanProfile(noOpContext, initialInput)).resolves.toMatchObject({
      changed: false,
      profile: { actorId: enabled.profile.actorId, handle: profileHandle },
    });
    await expectIdentityError(
      enableHumanProfile(conflictContext, {
        ...initialInput,
        displayName: "Conflicting Name",
      }),
      "HUMAN_PROFILE_ALREADY_ENABLED",
    );

    const updated = await updateHumanProfile(updateContext, {
      bio: "Tracks evidence, counterarguments, and revisions.",
      displayName: "Lifecycle Market Researcher",
    });
    expect(updated).toMatchObject({
      changed: true,
      profile: {
        actorId: enabled.profile.actorId,
        bio: "Tracks evidence, counterarguments, and revisions.",
        displayName: "Lifecycle Market Researcher",
        handle: profileHandle,
      },
    });

    const noOpOrConflictEffects = await postgres.sql<{ count: number }[]>`
        select count(*)::integer as count
        from platform.action_logs
        where request_id in (${noOpRequestId}, ${conflictRequestId})
      `;
    expect(noOpOrConflictEffects[0]?.count).toBe(0);

    const effects = await postgres.sql<HumanLifecycleEffectRow[]>`
        select
          log.action,
          log.actor_id::text as actor_id,
          log.actor_kind,
          log.after_state,
          log.approval_method,
          log.approved_by_owner_id::text as approved_by_owner_id,
          log.authentication_assurance,
          log.authorization_snapshot,
          log.before_state,
          log.channel,
          log.credential_id::text as credential_id,
          log.decision,
          event.aggregate_id as event_aggregate_id,
          event.aggregate_type as event_aggregate_type,
          event.payload as event_payload,
          event.event_type,
          event.event_version,
          (
            platform.audit_json_is_secret_free(log.authorization_snapshot)
            and platform.audit_json_is_secret_free(log.before_state)
            and platform.audit_json_is_secret_free(log.after_state)
            and platform.audit_json_is_secret_free(event.payload)
          ) as json_is_secret_free,
          log.owner_id::text as log_owner_id,
          log.outcome,
          log.policy_version::text as policy_version,
          log.request_id,
          log.target_id,
          log.target_type
        from platform.action_logs as log
        join system.outbox_events as event
          on event.id = log.outbox_event_id
        where log.request_id in (${enableRequestId}, ${updateRequestId})
        order by log.occurred_at, log.id
      `;
    expect(effects).toHaveLength(2);
    const lifecycleOutbox = await postgres.sql<
      { event_type: string; event_version: number }[]
    >`
      select event_type, event_version
      from system.outbox_events
      where aggregate_type = 'actor'
        and aggregate_id = ${enabled.profile.actorId}
        and event_type in ('human_profile.enabled', 'human_profile.updated')
      order by aggregate_sequence
    `;
    expect(lifecycleOutbox).toEqual([
      { event_type: "human_profile.enabled", event_version: 1 },
      { event_type: "human_profile.updated", event_version: 1 },
    ]);
    expect(effects[0]).toMatchObject({
      action: "human_profile.enable",
      actor_id: null,
      actor_kind: null,
      after_state: {
        bio_present: true,
        handle: profileHandle,
        status: "active",
      },
      approval_method: "owner_direct",
      approved_by_owner_id: owner.ownerId,
      authentication_assurance: "owner_session",
      authorization_snapshot: {
        authenticated_at: enableContext.authenticatedAt.toISOString(),
        csrf_validated: true,
        owner_session: true,
      },
      before_state: null,
      channel: "web",
      credential_id: null,
      decision: "allow",
      event_aggregate_id: enabled.profile.actorId,
      event_aggregate_type: "actor",
      event_payload: {
        actor_id: enabled.profile.actorId,
        handle: profileHandle,
        kind: "human",
        status: "active",
      },
      event_type: "human_profile.enabled",
      event_version: 1,
      json_is_secret_free: true,
      log_owner_id: owner.ownerId,
      outcome: "succeeded",
      policy_version: null,
      request_id: enableRequestId,
      target_id: enabled.profile.actorId,
      target_type: "human_profile",
    });
    expect(effects[1]).toMatchObject({
      action: "human_profile.update",
      after_state: {
        bio_present: true,
        changed_fields: ["display_name", "bio"],
        status: "active",
      },
      before_state: { bio_present: true, status: "active" },
      authorization_snapshot: {
        authenticated_at: updateContext.authenticatedAt.toISOString(),
        csrf_validated: true,
        owner_session: true,
      },
      event_aggregate_id: enabled.profile.actorId,
      event_payload: {
        actor_id: enabled.profile.actorId,
        changed_fields: ["display_name", "bio"],
        handle: profileHandle,
        kind: "human",
      },
      event_type: "human_profile.updated",
      json_is_secret_free: true,
      request_id: updateRequestId,
      target_id: enabled.profile.actorId,
    });
    const serializedEffects = JSON.stringify(effects);
    expect(serializedEffects).not.toContain(owner.email);
    expect(serializedEffects).not.toContain(enableContext.sessionId);
    expect(serializedEffects).not.toContain(updateContext.sessionId);
    expect(serializedEffects).not.toContain(owner.sessionToken);
    expect(serializedEffects).not.toMatch(
      /(?:password|api_key|access_token|refresh_token|credential_value)/iu,
    );
  });

  it("keeps handles global and permits exactly one human profile per Owner", async () => {
    const firstOwner = await createOwner({ label: "handle-first" });
    const secondOwner = await createOwner({ label: "handle-second" });
    const concurrentOwner = await createOwner({ label: "one-human" });
    const sharedHandle = handle("global-human");

    await enableHumanProfile(ownerWebMutation(firstOwner), {
      displayName: "First Researcher",
      handle: sharedHandle,
    });
    await expectIdentityError(
      enableHumanProfile(ownerWebMutation(secondOwner), {
        displayName: "Second Researcher",
        handle: sharedHandle,
      }),
      "HUMAN_PROFILE_HANDLE_TAKEN",
    );

    const concurrentResults = await Promise.allSettled([
      enableHumanProfile(ownerWebMutation(concurrentOwner), {
        displayName: "Concurrent A",
        handle: handle("concurrent-a"),
      }),
      enableHumanProfile(ownerWebMutation(concurrentOwner), {
        displayName: "Concurrent B",
        handle: handle("concurrent-b"),
      }),
    ]);
    expect(
      concurrentResults.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = concurrentResults.find((result) => result.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(OwnerSocialIdentityError);
    expect(rejected?.reason).toMatchObject({
      code: "HUMAN_PROFILE_ALREADY_ENABLED",
    });

    const counts = await postgres.sql<{ human_count: number }[]>`
        select count(*)::integer as human_count
        from platform.actors
        where owner_id = ${concurrentOwner.ownerId}
          and kind = 'human'
      `;
    expect(counts[0]?.human_count).toBe(1);
  });

  it("fails closed for unverified and suspended Owners while preserving restricted read-only access", async () => {
    const unverified = await createOwner({ label: "unverified", verified: false });
    const suspended = await createOwner({ label: "suspended" });
    const restricted = await createOwner({ label: "restricted" });
    const restrictedHuman = await enableHumanProfile(ownerWebMutation(restricted), {
      displayName: "Restricted Researcher",
      handle: handle("restricted-human"),
    });
    await postgres.sql`
      update platform.owners
      set status = 'suspended',
          restriction_reason_code = 'web_social_integration',
          suspended_at = clock_timestamp()
      where id = ${suspended.ownerId}
    `;
    await postgres.sql`
      update platform.owners
      set status = 'restricted',
          restriction_reason_code = 'web_social_integration',
          restricted_at = clock_timestamp()
      where id = ${restricted.ownerId}
    `;

    for (const [owner, expectedCode] of [
      [unverified, "OWNER_EMAIL_VERIFICATION_REQUIRED"],
      [suspended, "OWNER_NOT_ACTIVE"],
    ] as const) {
      const session = ownerWebSession(owner);
      const mutation = ownerWebMutation(owner);
      await expectIdentityError(
        enableHumanProfile(ownerWebMutation(owner), {
          displayName: "Unavailable",
          handle: handle("unavailable"),
        }),
        expectedCode,
      );
      await expectIdentityError(listOwnerPublicIdentities(session), expectedCode);
      await expectAuthorityError(
        mutation,
        {
          actorId: randomUUID(),
          kind: "human_direct",
        },
        "OWNER_NOT_ELIGIBLE",
      );
    }

    await expect(
      listOwnerPublicIdentities(ownerWebSession(restricted)),
    ).resolves.toMatchObject([
      {
        actorId: restrictedHuman.profile.actorId,
        kind: "human",
        status: "active",
      },
    ]);
    await expectIdentityError(
      updateHumanProfile(ownerWebMutation(restricted), {
        displayName: "Mutation Must Not Succeed",
      }),
      "OWNER_NOT_ACTIVE",
    );
    await expectAuthorityError(
      ownerWebMutation(restricted),
      {
        actorId: restrictedHuman.profile.actorId,
        kind: "human_direct",
      },
      "OWNER_NOT_ELIGIBLE",
    );
  });

  it("lists only active owned public identities without private Owner or Credential data", async () => {
    const owner = await createOwner({ label: "directory" });
    const foreignOwner = await createOwner({ label: "directory-foreign" });
    const human = await enableHumanProfile(ownerWebMutation(owner), {
      bio: "Public human biography",
      displayName: "Directory Researcher",
      handle: handle("directory-human"),
    });
    const activeAgent = await createAgent(owner.ownerId, "DirectoryActive");
    const archivedAgent = await createAgent(owner.ownerId, "DirectoryArchived");
    await agentService.archiveAgent(owner.ownerId, archivedAgent.agent.id, randomUUID());
    const foreignAgent = await createAgent(foreignOwner.ownerId, "DirectoryForeign");
    const issued = await agentService.createCredential(
      owner.ownerId,
      activeAgent.agent.id,
      { name: "Private directory credential", scopes: ["research:read"] },
      randomUUID(),
    );

    const identities = await listOwnerPublicIdentities(ownerWebSession(owner));
    expect(identities).toHaveLength(2);
    expect(identities.map((identity) => identity.actorId)).toEqual([
      human.profile.actorId,
      activeAgent.agent.actorId,
    ]);
    expect(identities.map((identity) => identity.actorId)).not.toContain(
      archivedAgent.agent.actorId,
    );
    expect(identities.map((identity) => identity.actorId)).not.toContain(
      foreignAgent.agent.actorId,
    );
    const activeAgentIdentity = identities.find(
      (identity) =>
        identity.kind === "agent" && identity.agentId === activeAgent.agent.id,
    );
    expect(activeAgentIdentity?.createdAt).toEqual(activeAgent.agent.createdAt);
    expect(activeAgentIdentity?.joinedAt).toEqual(activeAgent.agent.activatedAt);
    for (const identity of identities) {
      expect(Object.keys(identity).sort()).toEqual(
        [
          "actorId",
          "agentId",
          "bio",
          "createdAt",
          "discoveryTags",
          "displayName",
          "handle",
          "joinedAt",
          "kind",
          "status",
          "updatedAt",
        ].sort(),
      );
    }
    const serialized = JSON.stringify(identities);
    expect(serialized).not.toContain(owner.email);
    expect(serialized).not.toContain(issued.apiKey);
    expect(serialized).not.toContain(owner.sessionId);
    expect(serialized).not.toContain(owner.sessionToken);
    expect(serialized).not.toMatch(/(?:credential|email|ownerId)/iu);
  });

  it("resolves real human-direct and owner-direct authority and rejects forged identity chains", async () => {
    const owner = await createOwner({ label: "authority" });
    const foreignOwner = await createOwner({ label: "authority-foreign" });
    const ownerSession = ownerWebMutation(owner);
    const foreignOwnerSession = ownerWebMutation(foreignOwner);
    const human = await enableHumanProfile(ownerWebMutation(owner), {
      displayName: "Authority Human",
      handle: handle("authority-human"),
    });
    const foreignHuman = await enableHumanProfile(ownerWebMutation(foreignOwner), {
      displayName: "Foreign Authority Human",
      handle: handle("authority-foreign-human"),
    });
    const agent = await createAgent(owner.ownerId, "Authority");
    const foreignAgent = await createAgent(foreignOwner.ownerId, "AuthorityForeign");

    const invalidCsrfError = await postgres.sql
      .begin((transaction) =>
        authorityResolver.resolveAuthorityInTransaction(
          transaction,
          {
            ...ownerSession,
            csrfValidated: false,
          } as unknown as OwnerWebMutationContext,
          { actorId: human.profile.actorId, kind: "human_direct" },
        ),
      )
      .catch((caught: unknown) => caught);
    expect(invalidCsrfError).toBeInstanceOf(OwnerWebSessionContextError);
    expect(invalidCsrfError).toMatchObject({
      code: "INVALID_OWNER_WEB_SESSION_CONTEXT",
    });

    const humanAuthority = await resolveAuthorityInWriteTransaction(ownerSession, {
      actorId: human.profile.actorId,
      kind: "human_direct",
    });
    expect(humanAuthority).toMatchObject({
      actor: {
        id: human.profile.actorId,
        kind: "human",
        ownerId: owner.ownerId,
        status: "active",
      },
      agent: null,
      approvalMethod: "human_direct",
      channel: "web",
      credential: null,
      currentPolicy: null,
      kind: "human_direct",
      owner: { id: owner.ownerId },
      principalScopeKey: `human_web:${owner.ownerId}:${human.profile.actorId}`,
      requestContext: {
        authenticatedAt: ownerSession.authenticatedAt,
        authenticationAssurance: "owner_session",
        channel: "web",
        csrfValidated: true,
        ownerId: owner.ownerId,
        requestId: ownerSession.requestId,
      },
    });
    expect(humanAuthority.authorityCheckedAt).toBeInstanceOf(Date);
    expect(Object.keys(humanAuthority.requestContext).sort()).toEqual(
      [
        "authenticatedAt",
        "authenticationAssurance",
        "channel",
        "csrfValidated",
        "ownerId",
        "requestId",
      ].sort(),
    );
    expect(JSON.stringify(humanAuthority)).not.toContain(ownerSession.sessionId);
    expect(JSON.stringify(humanAuthority)).not.toContain(owner.sessionToken);

    const assistedAuthority = await postgres.sql.begin((transaction) =>
      authorityResolver.resolveAuthorityInTransaction(transaction, ownerSession, {
        agentId: agent.agent.id,
        kind: "owner_direct",
      }),
    );
    expect(assistedAuthority).toMatchObject({
      actor: {
        id: agent.agent.actorId,
        kind: "agent",
        ownerId: owner.ownerId,
      },
      agent: {
        actorId: agent.agent.actorId,
        id: agent.agent.id,
        ownerId: owner.ownerId,
        policy: { tier: "assisted", version: "1" },
      },
      approvalMethod: "owner_direct",
      channel: "web",
      credential: null,
      currentPolicy: { tier: "assisted", version: "1" },
      kind: "owner_direct",
      principalScopeKey: `owner_direct:${owner.ownerId}:${agent.agent.id}`,
      requestContext: {
        ownerId: owner.ownerId,
        requestId: ownerSession.requestId,
      },
    });
    if (assistedAuthority.kind !== "owner_direct") {
      throw new Error("Expected owner-direct authority");
    }
    expect(evaluateOwnerDirectOperation(assistedAuthority, "create_post")).toEqual({
      approvalSatisfied: true,
      decision: "allow",
      ownerPolicyDecision: "require_approval",
      reason: "OWNER_DIRECT_APPROVAL_SATISFIED",
    });

    for (const [context, forgedSelection] of [
      [
        ownerSession,
        {
          actorId: foreignHuman.profile.actorId,
          kind: "human_direct",
        },
      ],
      [
        ownerSession,
        {
          agentId: foreignAgent.agent.id,
          kind: "owner_direct",
        },
      ],
      [
        foreignOwnerSession,
        {
          agentId: agent.agent.id,
          kind: "owner_direct",
        },
      ],
    ] as const) {
      await expectAuthorityError(context, forgedSelection, "AUTHORITY_NOT_FOUND");
    }

    await agentService.updateAgentPolicy(
      owner.ownerId,
      agent.agent.id,
      {
        authenticatedAt: new Date(0),
        authenticationAssurance: "owner_session",
        autonomousAcknowledged: false,
        expectedVersion: "1",
        rules: { operations: { content_write: "deny" } },
        tier: "custom",
      },
      randomUUID(),
    );
    const deniedAuthority = await resolveAuthorityInWriteTransaction(ownerSession, {
      agentId: agent.agent.id,
      kind: "owner_direct",
    });
    if (deniedAuthority.kind !== "owner_direct") {
      throw new Error("Expected owner-direct authority");
    }
    expect(deniedAuthority.currentPolicy).toMatchObject({
      tier: "custom",
      version: "2",
    });
    expect(evaluateOwnerDirectOperation(deniedAuthority, "create_post")).toEqual({
      approvalSatisfied: false,
      decision: "deny",
      ownerPolicyDecision: "deny",
      reason: "POLICY_DENIED",
    });
  });

  it("holds transaction-bound authority locks through the caller transaction", async () => {
    const owner = await createOwner({ label: "authority-lock" });
    const agent = await createAgent(owner.ownerId, "AuthorityLock");
    const context = ownerWebMutation(owner);
    const human = await enableHumanProfile(ownerWebMutation(owner), {
      displayName: "Authority Lock Human",
      handle: handle("authority-lock-human"),
    });

    await postgres.sql.begin(async (transaction) => {
      const authority = await authorityResolver.resolveAuthorityInTransaction(
        transaction,
        context,
        {
          agentId: agent.agent.id,
          kind: "owner_direct",
        },
      );
      expect(authority).toMatchObject({
        agent: { id: agent.agent.id, status: "active" },
        currentPolicy: { id: agent.agent.policy.id, version: "1" },
        kind: "owner_direct",
      });

      await expectLockTimeout(
        competingPostgres.sql.begin(async (competitor) => {
          await competitor`set local lock_timeout = '250ms'`;
          await competitor`set local statement_timeout = '2s'`;
          await competitor`
            update platform.owners
            set status = status
            where id = ${owner.ownerId}
          `;
          throw new Error("The Owner row changed while authority locks were held");
        }),
      );

      await expectLockTimeout(
        competingPostgres.sql.begin(async (competitor) => {
          await competitor`set local lock_timeout = '250ms'`;
          await competitor`set local statement_timeout = '2s'`;
          await competitor`
            update platform.actors
            set display_name = display_name
            where id = ${agent.agent.actorId}
              and owner_id = ${owner.ownerId}
          `;
          throw new Error("The Agent Actor row changed while authority locks were held");
        }),
      );

      await expectLockTimeout(
        competingPostgres.sql.begin(async (competitor) => {
          await competitor`set local lock_timeout = '250ms'`;
          await competitor`set local statement_timeout = '2s'`;
          await competitor`
            update platform.agent_policies
            set is_active = false
            where id = ${agent.agent.policy.id}
              and agent_id = ${agent.agent.id}
              and is_active
          `;
          throw new Error("The policy row changed while authority locks were held");
        }),
      );

      await expectLockTimeout(
        competingPostgres.sql.begin(async (competitor) => {
          await competitor`set local lock_timeout = '250ms'`;
          await competitor`set local statement_timeout = '2s'`;
          await competitor`
            update platform.agents
            set status = 'restricted',
                restriction_reason_code = 'authority_lock_test',
                restricted_at = clock_timestamp(),
                updated_at = clock_timestamp()
            where id = ${agent.agent.id}
              and owner_id = ${owner.ownerId}
          `;
          throw new Error("The Agent row changed while authority locks were held");
        }),
      );
    });

    await postgres.sql.begin(async (transaction) => {
      const authority = await authorityResolver.resolveAuthorityInTransaction(
        transaction,
        context,
        {
          actorId: human.profile.actorId,
          kind: "human_direct",
        },
      );
      expect(authority).toMatchObject({
        actor: { id: human.profile.actorId, kind: "human", status: "active" },
        kind: "human_direct",
      });

      await expectLockTimeout(
        competingPostgres.sql.begin(async (competitor) => {
          await competitor`set local lock_timeout = '250ms'`;
          await competitor`set local statement_timeout = '2s'`;
          await competitor`
            update platform.actors
            set display_name = display_name
            where id = ${human.profile.actorId}
              and owner_id = ${owner.ownerId}
          `;
          throw new Error("The human Actor row changed while authority locks were held");
        }),
      );
    });

    const unchanged = await postgres.sql<
      { agent_status: string; policy_active: boolean }[]
    >`
      select
        agent.status as agent_status,
        policy.is_active as policy_active
      from platform.agents as agent
      join platform.agent_policies as policy
        on policy.agent_id = agent.id
       and policy.id = ${agent.agent.policy.id}
      where agent.id = ${agent.agent.id}
    `;
    expect(unchanged).toEqual([{ agent_status: "active", policy_active: true }]);
  });
});
