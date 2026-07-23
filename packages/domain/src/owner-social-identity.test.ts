import type { PostgresClient } from "@alphanet/database";
import { describe, expect, it } from "vitest";

import { PostgresOwnerSocialIdentityService } from "./owner-social-identity.js";
import {
  createOwnerWebContextAuthority,
  OwnerWebSessionContextError,
  type OwnerWebMutationContext,
  type OwnerWebSessionContext,
} from "./owner-web-session-context.js";
import { OWNER_WEB_SOCIAL_V1_MIGRATION_CHECKSUM } from "./schema-migrations.js";

const ownerA = "00000000-0000-4000-8000-000000000001";
const ownerB = "00000000-0000-4000-8000-000000000002";
const ownerC = "00000000-0000-4000-8000-000000000003";
const humanActorId = "00000000-0000-4000-8000-000000000101";
const agentActorA = "00000000-0000-4000-8000-000000000201";
const agentA = "00000000-0000-4000-8000-000000000202";
const agentActorB = "00000000-0000-4000-8000-000000000301";
const agentB = "00000000-0000-4000-8000-000000000302";
const sessionId = "00000000-0000-4000-8000-000000000401";
const baseTime = new Date("2026-07-22T20:00:00.000Z");
const databaseTime = new Date("2026-07-22T21:00:00.000Z");
const contextAuthority = createOwnerWebContextAuthority();

interface CapturedQuery {
  text: string;
  values: unknown[];
}

interface StoredOwner {
  credentialSecret: string;
  email: string;
  id: string;
  status: string;
  verifiedAt: Date | null;
}

interface StoredActor {
  actorId: string;
  agentId: string | null;
  agentStatus: string | null;
  bio: string | null;
  createdAt: Date;
  deletedAt: Date | null;
  discoveryTags: string[];
  displayName: string;
  handle: string;
  kind: "agent" | "human";
  ownerId: string;
  status: string;
  updatedAt: Date;
}

interface FakeTransaction {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
  json(value: unknown): unknown;
}

interface FakeRootSql extends FakeTransaction {
  begin<T>(callback: (transaction: FakeTransaction) => Promise<T>): Promise<T>;
}

class FakeDatabaseError extends Error {
  readonly code = "23505";
  readonly constraint_name: string;

  constructor(constraintName: string) {
    super(`duplicate key violates ${constraintName}`);
    this.constraint_name = constraintName;
  }
}

class SocialIdentityHarness {
  readonly actors: StoredActor[] = [];
  readonly owners = new Map<string, StoredOwner>();
  readonly queries: CapturedQuery[] = [];
  readonly sql: PostgresClient;
  ready = true;
  triggersEnabled = true;
  #clockTick = 0;
  #outboxId = 1;
  #transactionTail: Promise<void> = Promise.resolve();
  readonly #outboxSequences = new Map<string, number>();

  constructor() {
    this.addOwner(ownerA, "active", true);
    this.addOwner(ownerB, "active", true);
    this.addOwner(ownerC, "active", false);
    const sql = this.#tag() as FakeRootSql;
    sql.begin = async <T>(callback: (transaction: FakeTransaction) => Promise<T>) => {
      const previous = this.#transactionTail;
      let release!: () => void;
      this.#transactionTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await callback(this.#tag());
      } finally {
        release();
      }
    };
    this.sql = sql as unknown as PostgresClient;
  }

  addOwner(id: string, status: string, verified: boolean): void {
    this.owners.set(id, {
      credentialSecret: `aln_v1_private-${id}`,
      email: `${id}@private.example.test`,
      id,
      status,
      verifiedAt: verified ? new Date(baseTime.valueOf()) : null,
    });
  }

  addAgent(input: {
    actorId: string;
    agentId: string;
    displayName: string;
    handle: string;
    ownerId: string;
    status?: string | undefined;
  }): void {
    this.actors.push({
      actorId: input.actorId,
      agentId: input.agentId,
      agentStatus: input.status ?? "active",
      bio: "Public Agent biography",
      createdAt: this.#now(),
      deletedAt: null,
      discoveryTags: ["semiconductors"],
      displayName: input.displayName,
      handle: input.handle,
      kind: "agent",
      ownerId: input.ownerId,
      status: input.status ?? "active",
      updatedAt: this.#now(),
    });
  }

  setHumanStatus(ownerId: string, status: string): void {
    const actor = this.actors.find(
      (candidate) => candidate.ownerId === ownerId && candidate.kind === "human",
    );
    if (!actor) throw new Error("The test human profile does not exist.");
    actor.status = status;
  }

  actionQueries(): CapturedQuery[] {
    return this.queries.filter((query) =>
      query.text.startsWith("insert into platform.action_logs"),
    );
  }

  outboxQueries(): CapturedQuery[] {
    return this.queries.filter((query) =>
      query.text.startsWith("insert into system.outbox_events"),
    );
  }

  #now(): Date {
    return new Date(baseTime.valueOf() + this.#clockTick++ * 1_000);
  }

  #row(actor: StoredActor) {
    return {
      actor_id: actor.actorId,
      agent_id: actor.agentId,
      bio: actor.bio,
      created_at: actor.createdAt,
      discovery_tags: [...actor.discoveryTags],
      display_name: actor.displayName,
      handle: actor.handle,
      joined_at: actor.createdAt,
      kind: actor.kind,
      status: actor.status,
      updated_at: actor.updatedAt,
    };
  }

  #tag(): FakeTransaction {
    const tag = (async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<unknown[]> => {
      await Promise.resolve();
      const text = strings.join(" ? ").replace(/\s+/gu, " ").trim();
      this.queries.push({ text, values });
      if (text.includes("select statement_timestamp() as authority_checked_at")) {
        return [{ authority_checked_at: new Date(databaseTime.valueOf()) }];
      }
      if (text.startsWith("set local")) return [];
      if (text.includes("system.schema_migrations") && text.includes("as ready")) {
        return [{ ready: this.ready && this.triggersEnabled }];
      }
      if (text.includes("from platform.owners")) {
        const owner = this.owners.get(String(values[0]));
        return owner
          ? [
              {
                email_verified_at: owner.verifiedAt,
                id: owner.id,
                status: owner.status,
              },
            ]
          : [];
      }
      if (
        text.includes("from platform.actors as actor") &&
        text.includes("left join platform.agents as agent")
      ) {
        const queriedOwnerId = String(values[0]);
        return this.actors
          .filter(
            (actor) =>
              actor.ownerId === queriedOwnerId &&
              actor.status === "active" &&
              actor.deletedAt === null &&
              (actor.kind === "human" || actor.agentStatus === "active"),
          )
          .sort((left, right) => {
            if (left.kind !== right.kind) return left.kind === "human" ? -1 : 1;
            return left.displayName.localeCompare(right.displayName);
          })
          .map((actor) => this.#row(actor));
      }
      if (
        text.includes("from platform.actors as actor") &&
        text.includes("actor.kind = 'human'")
      ) {
        const queriedOwnerId = String(values[0]);
        const actor = this.actors.find(
          (candidate) =>
            candidate.ownerId === queriedOwnerId && candidate.kind === "human",
        );
        return actor ? [this.#row(actor)] : [];
      }
      if (text.startsWith("insert into platform.actors")) {
        const [actorId, queriedOwnerId, handle, displayName, bio] = values as [
          string,
          string,
          string,
          string,
          string | null,
        ];
        if (this.actors.some((actor) => actor.handle === handle)) {
          throw new FakeDatabaseError("actors_handle_unique");
        }
        if (
          this.actors.some(
            (actor) => actor.ownerId === queriedOwnerId && actor.kind === "human",
          )
        ) {
          throw new FakeDatabaseError("actors_one_human_per_owner");
        }
        const timestamp = this.#now();
        const actor: StoredActor = {
          actorId,
          agentId: null,
          agentStatus: null,
          bio,
          createdAt: timestamp,
          deletedAt: null,
          discoveryTags: [],
          displayName,
          handle,
          kind: "human",
          ownerId: queriedOwnerId,
          status: "active",
          updatedAt: timestamp,
        };
        this.actors.push(actor);
        return [this.#row(actor)];
      }
      if (text.startsWith("update platform.actors")) {
        const [displayName, bio, actorId, queriedOwnerId] = values as [
          string,
          string | null,
          string,
          string,
        ];
        const actor = this.actors.find(
          (candidate) =>
            candidate.actorId === actorId &&
            candidate.ownerId === queriedOwnerId &&
            candidate.kind === "human" &&
            candidate.status === "active" &&
            candidate.deletedAt === null,
        );
        if (!actor) return [];
        actor.displayName = displayName;
        actor.bio = bio;
        actor.updatedAt = this.#now();
        return [this.#row(actor)];
      }
      if (text.includes("pg_catalog.pg_advisory_xact_lock")) return [];
      if (text.includes("from system.outbox_aggregate_heads as head")) {
        const aggregateType = String(values[0]);
        const aggregateId = String(values[1]);
        const key = `${aggregateType}:${aggregateId}`;
        return [{ next_sequence: String((this.#outboxSequences.get(key) ?? 0) + 1) }];
      }
      if (text.startsWith("insert into system.outbox_events")) {
        const aggregateType = String(values[0]);
        const aggregateId = String(values[1]);
        const sequence = String(values[2]);
        this.#outboxSequences.set(`${aggregateType}:${aggregateId}`, Number(sequence));
        return [
          {
            aggregate_sequence: sequence,
            id: `00000000-0000-4000-8001-${String(this.#outboxId++).padStart(12, "0")}`,
          },
        ];
      }
      if (text.startsWith("insert into platform.action_logs")) return [];
      throw new Error(`Unexpected SQL in Owner social identity test: ${text}`);
    }) as FakeTransaction;
    tag.json = (value: unknown) => value;
    return tag;
  }
}

function service(harness: SocialIdentityHarness): PostgresOwnerSocialIdentityService {
  return new PostgresOwnerSocialIdentityService(harness.sql, {
    contextVerifier: contextAuthority.verifier,
    idFactory: () => humanActorId,
  });
}

function enableInput(handle = "human-alpha") {
  return {
    bio: "Public human research biography",
    displayName: "Human Alpha",
    handle,
  };
}

function sessionContext(
  forOwner = ownerA,
  overrides: Record<string, unknown> = {},
): OwnerWebSessionContext {
  return contextAuthority.issuer.issueSessionContext({
    ownerId: forOwner,
    sessionId,
    requestId: "req-owner-social-identity",
    authenticatedAt: new Date(baseTime.valueOf()),
    authenticationAssurance: "owner_session",
    ...overrides,
  });
}

function mutationContext(
  forOwner = ownerA,
  overrides: Record<string, unknown> = {},
): OwnerWebMutationContext {
  return contextAuthority.issuer.issueMutationContext({
    ownerId: forOwner,
    sessionId,
    requestId: "req-owner-social-identity",
    authenticatedAt: new Date(baseTime.valueOf()),
    authenticationAssurance: "owner_session",
    ...overrides,
  });
}

function rawMutationContext(
  forOwner = ownerA,
  overrides: Record<string, unknown> = {},
): OwnerWebMutationContext {
  return {
    ownerId: forOwner,
    sessionId,
    requestId: "req-owner-social-identity",
    authenticatedAt: new Date(baseTime.valueOf()),
    authenticationAssurance: "owner_session",
    csrfValidated: true,
    ...overrides,
  } as unknown as OwnerWebMutationContext;
}

describe("PostgresOwnerSocialIdentityService", () => {
  it("pins readiness to the exact Owner Web social migration and identity guards", async () => {
    const harness = new SocialIdentityHarness();
    await expect(service(harness).checkReady()).resolves.toBeUndefined();
    const readiness = harness.queries.find((query) =>
      query.text.includes("system.schema_migrations"),
    );
    expect(readiness?.values).toContain(OWNER_WEB_SOCIAL_V1_MIGRATION_CHECKSUM);
    expect(readiness?.text).toContain("actors_one_human_per_owner");
    expect(readiness?.text).toContain("actors_enforce_canonical_handle");
    expect(readiness?.text).toContain("actors_prepare_update");
    expect(readiness?.text.match(/tgenabled in \('O', 'A'\)/gu)).toHaveLength(2);

    harness.triggersEnabled = false;
    await expect(service(harness).checkReady()).rejects.toThrow(
      "Owner social identity schema is not ready",
    );
  });

  it("enables one public human profile and lists only the Owner's usable public identities", async () => {
    const harness = new SocialIdentityHarness();
    harness.addAgent({
      actorId: agentActorA,
      agentId: agentA,
      displayName: "Alpha Research Agent",
      handle: "alpha-research",
      ownerId: ownerA,
    });
    harness.addAgent({
      actorId: agentActorB,
      agentId: agentB,
      displayName: "Beta Research Agent",
      handle: "beta-research",
      ownerId: ownerB,
    });
    const identityService = service(harness);

    const enabled = await identityService.enableHumanProfile(
      mutationContext(),
      enableInput(),
    );
    expect(enabled).toMatchObject({
      changed: true,
      profile: {
        actorId: humanActorId,
        agentId: null,
        bio: "Public human research biography",
        discoveryTags: [],
        displayName: "Human Alpha",
        handle: "human-alpha",
        kind: "human",
        status: "active",
      },
    });

    const ownerAIdentities =
      await identityService.listOwnerPublicIdentities(sessionContext());
    expect(ownerAIdentities).toMatchObject([
      { actorId: humanActorId, agentId: null, handle: "human-alpha", kind: "human" },
      { actorId: agentActorA, agentId: agentA, handle: "alpha-research", kind: "agent" },
    ]);
    await expect(
      identityService.listOwnerPublicIdentities(sessionContext(ownerB)),
    ).resolves.toMatchObject([
      { actorId: agentActorB, agentId: agentB, handle: "beta-research", kind: "agent" },
    ]);
    const readOwnerLocks = harness.queries.filter(
      (query) =>
        query.text.includes("from platform.owners") && query.text.endsWith("for share"),
    );
    expect(readOwnerLocks).toHaveLength(2);
    const identityDirectoryQuery = harness.queries.find((query) =>
      query.text.includes("left join platform.agents as agent"),
    );
    expect(identityDirectoryQuery?.text).toContain(
      "case when actor.kind = 'agent' then agent.created_at else actor.created_at end as created_at",
    );
    expect(harness.queries.some((query) => query.text.includes("for key share"))).toBe(
      false,
    );

    const publicJson = JSON.stringify(ownerAIdentities);
    expect(publicJson).not.toContain("private.example.test");
    expect(publicJson).not.toContain("aln_v1_private");
    expect(publicJson).not.toContain(ownerB);
    expect(harness.actionQueries()).toHaveLength(1);
    expect(harness.outboxQueries()).toHaveLength(1);
    const durableEventJson = JSON.stringify([
      ...harness.actionQueries(),
      ...harness.outboxQueries(),
    ]);
    expect(durableEventJson).not.toContain("Public human research biography");
    expect(durableEventJson).not.toContain("private.example.test");
    expect(durableEventJson).not.toContain("aln_v1_private");
    expect(durableEventJson).not.toContain(sessionId);
  });

  it("requires an active, verified Owner and returns stable errors", async () => {
    const harness = new SocialIdentityHarness();
    harness.owners.get(ownerB)!.status = "suspended";
    const identityService = service(harness);

    await expect(
      identityService.enableHumanProfile(
        mutationContext(ownerB),
        enableInput("human-beta"),
      ),
    ).rejects.toMatchObject({
      code: "OWNER_NOT_ACTIVE",
      retryable: false,
      statusCode: 403,
    });
    await expect(
      identityService.enableHumanProfile(
        mutationContext(ownerC),
        enableInput("human-gamma"),
      ),
    ).rejects.toMatchObject({
      code: "OWNER_EMAIL_VERIFICATION_REQUIRED",
      retryable: false,
      statusCode: 403,
    });
    await expect(
      identityService.listOwnerPublicIdentities(sessionContext(ownerB)),
    ).rejects.toMatchObject({ code: "OWNER_NOT_ACTIVE", statusCode: 403 });
    expect(harness.actors).toHaveLength(0);
    expect(harness.actionQueries()).toHaveLength(0);
    expect(harness.outboxQueries()).toHaveLength(0);
  });

  it.each([
    ["future", new Date(databaseTime.valueOf() + 1)],
    ["non-finite", new Date(Number.NaN)],
  ])(
    "rejects a %s Owner verification time against database authority time",
    async (_label, verifiedAt) => {
      const harness = new SocialIdentityHarness();
      harness.owners.get(ownerA)!.verifiedAt = verifiedAt;
      const identityService = service(harness);

      await expect(
        identityService.listOwnerPublicIdentities(sessionContext()),
      ).rejects.toMatchObject({
        code: "OWNER_EMAIL_VERIFICATION_REQUIRED",
        retryable: false,
        statusCode: 403,
      });
      await expect(
        identityService.enableHumanProfile(mutationContext(), enableInput()),
      ).rejects.toMatchObject({
        code: "OWNER_EMAIL_VERIFICATION_REQUIRED",
        retryable: false,
        statusCode: 403,
      });
      expect(harness.actors).toHaveLength(0);
      expect(harness.actionQueries()).toHaveLength(0);
      expect(harness.outboxQueries()).toHaveLength(0);
    },
  );

  it("enforces canonical immutable handles and global cross-Owner uniqueness", async () => {
    const harness = new SocialIdentityHarness();
    const identityService = service(harness);

    await expect(
      identityService.enableHumanProfile(
        mutationContext(undefined, { requestId: "req-case" }),
        enableInput("Human-Alpha"),
      ),
    ).rejects.toMatchObject({
      code: "HUMAN_PROFILE_INPUT_INVALID",
      statusCode: 422,
    });
    await identityService.enableHumanProfile(
      mutationContext(undefined, { requestId: "req-a" }),
      enableInput("shared-human"),
    );
    await expect(
      identityService.enableHumanProfile(
        mutationContext(ownerB, { requestId: "req-b" }),
        enableInput("shared-human"),
      ),
    ).rejects.toMatchObject({
      code: "HUMAN_PROFILE_HANDLE_TAKEN",
      statusCode: 409,
    });
    await expect(
      identityService.updateHumanProfile(
        mutationContext(undefined, { requestId: "req-handle-update" }),
        { displayName: "Renamed", handle: "replacement" } as never,
      ),
    ).rejects.toMatchObject({
      code: "HUMAN_PROFILE_INPUT_INVALID",
      statusCode: 422,
    });
    expect(harness.actors.filter((actor) => actor.kind === "human")).toHaveLength(1);
    expect(harness.actors.find((actor) => actor.kind === "human")?.handle).toBe(
      "shared-human",
    );
  });

  it("serializes concurrent enable retries and rejects a conflicting second profile", async () => {
    const harness = new SocialIdentityHarness();
    const identityService = service(harness);
    const input = enableInput("concurrent-human");

    const results = await Promise.all([
      identityService.enableHumanProfile(
        mutationContext(undefined, { requestId: "req-concurrent-a" }),
        input,
      ),
      identityService.enableHumanProfile(
        mutationContext(undefined, { requestId: "req-concurrent-b" }),
        input,
      ),
    ]);
    expect(results.map((result) => result.changed).sort()).toEqual([false, true]);
    expect(results[0].profile.actorId).toBe(results[1].profile.actorId);
    expect(harness.actors.filter((actor) => actor.kind === "human")).toHaveLength(1);
    expect(harness.actionQueries()).toHaveLength(1);
    expect(harness.outboxQueries()).toHaveLength(1);

    await expect(
      identityService.enableHumanProfile(
        mutationContext(undefined, { requestId: "req-conflict" }),
        { ...input, displayName: "Conflicting Name" },
      ),
    ).rejects.toMatchObject({
      code: "HUMAN_PROFILE_ALREADY_ENABLED",
      statusCode: 409,
    });
  });

  it("updates public prose without mutating the handle and makes exact retries no-ops", async () => {
    const harness = new SocialIdentityHarness();
    const identityService = service(harness);
    await identityService.enableHumanProfile(
      mutationContext(undefined, { requestId: "req-enable" }),
      enableInput(),
    );

    const updated = await identityService.updateHumanProfile(
      mutationContext(undefined, { requestId: "req-update" }),
      { bio: null, displayName: " Human Alpha Updated " },
    );
    expect(updated).toMatchObject({
      changed: true,
      profile: {
        bio: null,
        displayName: "Human Alpha Updated",
        handle: "human-alpha",
      },
    });
    await expect(
      identityService.updateHumanProfile(
        mutationContext(undefined, { requestId: "req-update-retry" }),
        { bio: null, displayName: "Human Alpha Updated" },
      ),
    ).resolves.toMatchObject({ changed: false });
    expect(harness.actionQueries()).toHaveLength(2);
    expect(harness.outboxQueries()).toHaveLength(2);
    const updateSql = harness.queries.find((query) =>
      query.text.startsWith("update platform.actors"),
    );
    expect(updateSql?.text).not.toContain("handle =");

    harness.setHumanStatus(ownerA, "restricted");
    await expect(
      identityService.updateHumanProfile(
        mutationContext(undefined, { requestId: "req-blocked" }),
        { displayName: "Blocked" },
      ),
    ).rejects.toMatchObject({
      code: "HUMAN_PROFILE_STATE_CONFLICT",
      statusCode: 409,
    });
  });

  it("allows restricted Owners to read active identities but denies mutations", async () => {
    const harness = new SocialIdentityHarness();
    harness.owners.get(ownerA)!.status = "restricted";
    harness.addAgent({
      actorId: agentActorA,
      agentId: agentA,
      displayName: "Restricted Owner Agent",
      handle: "restricted-owner-agent",
      ownerId: ownerA,
    });
    const identityService = service(harness);

    await expect(
      identityService.listOwnerPublicIdentities(sessionContext()),
    ).resolves.toMatchObject([{ actorId: agentActorA, status: "active" }]);
    await expect(
      identityService.enableHumanProfile(
        mutationContext(),
        enableInput("restricted-human"),
      ),
    ).rejects.toMatchObject({ code: "OWNER_NOT_ACTIVE", statusCode: 403 });
    expect(harness.actors.filter((actor) => actor.kind === "human")).toHaveLength(0);
  });

  it("validates database-bound session time and CSRF before Owner access", async () => {
    const foreignContext = createOwnerWebContextAuthority().issuer.issueMutationContext({
      ownerId: ownerA,
      sessionId,
      requestId: "req-foreign-owner-social-authority",
      authenticatedAt: new Date(baseTime.valueOf()),
      authenticationAssurance: "owner_session",
    });
    for (const [context, code, statusCode] of [
      [
        mutationContext(undefined, {
          authenticatedAt: new Date(databaseTime.valueOf() + 1),
        }),
        "OWNER_WEB_AUTHENTICATION_TIME_INVALID",
        401,
      ],
      [sessionContext() as OwnerWebMutationContext, "OWNER_WEB_CSRF_REQUIRED", 403],
      [
        rawMutationContext(undefined, { csrfValidated: false }),
        "INVALID_OWNER_WEB_SESSION_CONTEXT",
        400,
      ],
      [foreignContext, "INVALID_OWNER_WEB_SESSION_CONTEXT", 400],
    ] as const) {
      const harness = new SocialIdentityHarness();
      const error = await service(harness)
        .enableHumanProfile(context, enableInput())
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(OwnerWebSessionContextError);
      expect(error).toMatchObject({ code, statusCode });
      expect(harness.queries[0]?.text).toContain(
        "select statement_timestamp() as authority_checked_at",
      );
      expect(
        harness.queries.some((query) => query.text.includes("platform.owners")),
      ).toBe(false);
      expect(harness.actionQueries()).toHaveLength(0);
      expect(harness.outboxQueries()).toHaveLength(0);
    }
  });

  it("records only approved session audit facts using the actual assurance", async () => {
    const harness = new SocialIdentityHarness();
    const context = mutationContext(undefined, {
      requestId: "req-fresh-owner",
      authenticationAssurance: "fresh_owner_session",
    });

    const result = await service(harness).enableHumanProfile(context, {
      displayName: "No Bio Human",
      handle: "no-bio-human",
    });
    expect(result.profile.bio).toBeNull();
    await expect(
      service(harness).enableHumanProfile(
        mutationContext(undefined, { requestId: "req-null-bio-retry" }),
        { bio: null, displayName: "No Bio Human", handle: "no-bio-human" },
      ),
    ).resolves.toMatchObject({ changed: false, profile: { bio: null } });

    const action = harness.actionQueries()[0];
    expect(action?.values).toContain("fresh_owner_session");
    expect(action?.values).toContainEqual({
      authenticated_at: baseTime.toISOString(),
      csrf_validated: true,
      owner_session: true,
    });
    const durableJson = JSON.stringify([
      result,
      ...harness.actionQueries(),
      ...harness.outboxQueries(),
    ]);
    expect(durableJson).not.toContain(sessionId);
    expect(durableJson).not.toContain("cookie");
    expect(durableJson).not.toContain("token");
    expect(durableJson).not.toContain("private.example.test");
  });

  it("rejects private context extras without persisting or returning them", async () => {
    const harness = new SocialIdentityHarness();
    const privateContext = rawMutationContext(undefined, {
      cookie: "private-owner-cookie",
    });
    const error = await service(harness)
      .enableHumanProfile(privateContext, enableInput())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OwnerWebSessionContextError);
    expect(error).toMatchObject({
      code: "INVALID_OWNER_WEB_SESSION_CONTEXT",
      statusCode: 400,
    });
    expect(JSON.stringify(error)).not.toContain("private-owner-cookie");
    expect(harness.actors).toHaveLength(0);
    expect(harness.actionQueries()).toHaveLength(0);
    expect(harness.outboxQueries()).toHaveLength(0);
  });

  it("distinguishes a missing profile from invalid request metadata", async () => {
    const harness = new SocialIdentityHarness();
    const identityService = service(harness);
    await expect(
      identityService.updateHumanProfile(
        mutationContext(undefined, { requestId: "req-none" }),
        { displayName: "No profile" },
      ),
    ).rejects.toMatchObject({
      code: "HUMAN_PROFILE_NOT_ENABLED",
      statusCode: 404,
    });
    const invalidContext = rawMutationContext(undefined, { requestId: " padded " });
    const error = await identityService
      .enableHumanProfile(invalidContext, enableInput())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OwnerWebSessionContextError);
    expect(error).toMatchObject({
      code: "INVALID_OWNER_WEB_SESSION_CONTEXT",
      statusCode: 400,
    });
  });
});
