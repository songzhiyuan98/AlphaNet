import { OwnerAvailablePublicIdentitiesResponseSchema } from "@alphanet/contracts";
import type {
  OwnerAgentPublicIdentityView,
  OwnerHumanPublicIdentityView,
  OwnerPublicIdentityView,
} from "@alphanet/domain";
import { describe, expect, it } from "vitest";

import { projectOwnerAvailablePublicIdentities } from "./owner-social-projector.js";

const ids = {
  agent: "30000000-0000-4000-8000-000000000001",
  agentActor: "20000000-0000-4000-8000-000000000001",
  humanActor: "10000000-0000-4000-8000-000000000001",
  otherActor: "20000000-0000-4000-8000-000000000002",
} as const;

function humanIdentity(
  overrides: Partial<OwnerHumanPublicIdentityView> = {},
): OwnerHumanPublicIdentityView {
  return {
    actorId: ids.humanActor,
    agentId: null,
    bio: "Independent market researcher",
    createdAt: new Date("2026-07-20T12:00:00.000Z"),
    discoveryTags: [],
    displayName: "Alpha Researcher",
    handle: "alpha-researcher",
    joinedAt: new Date("2026-07-20T12:00:00.000Z"),
    kind: "human",
    status: "active",
    updatedAt: new Date("2026-07-21T13:00:00.000Z"),
    ...overrides,
  };
}

function agentIdentity(
  overrides: Partial<OwnerAgentPublicIdentityView> = {},
): OwnerAgentPublicIdentityView {
  return {
    actorId: ids.agentActor,
    agentId: ids.agent,
    bio: "Semiconductor supply-chain research Agent",
    createdAt: new Date("2026-07-20T14:00:00.000Z"),
    discoveryTags: ["semiconductors", "supply-chain"],
    displayName: "Memory Research Agent",
    handle: "memory-research-agent",
    joinedAt: new Date("2026-07-21T15:00:00.000Z"),
    kind: "agent",
    status: "active",
    updatedAt: new Date("2026-07-22T16:00:00.000Z"),
    ...overrides,
  };
}

describe("projectOwnerAvailablePublicIdentities", () => {
  it("projects ordered human and Agent choices through the strict v1 contract", () => {
    const response = projectOwnerAvailablePublicIdentities(
      [humanIdentity(), agentIdentity()],
      "req-owner-identities",
    );

    expect(OwnerAvailablePublicIdentitiesResponseSchema.safeParse(response).success).toBe(
      true,
    );
    expect(response).toEqual({
      schema_version: "1",
      request_id: "req-owner-identities",
      identities: [
        {
          kind: "human",
          selection: { actor_kind: "human", actor_id: ids.humanActor },
          profile: {
            actor_id: ids.humanActor,
            kind: "human",
            handle: "alpha-researcher",
            display_name: "Alpha Researcher",
            bio: "Independent market researcher",
            status: "active",
            created_at: "2026-07-20T12:00:00.000Z",
            updated_at: "2026-07-21T13:00:00.000Z",
          },
        },
        {
          kind: "agent",
          selection: { actor_kind: "agent", agent_id: ids.agent },
          profile: {
            id: ids.agent,
            actor_id: ids.agentActor,
            handle: "memory-research-agent",
            display_name: "Memory Research Agent",
            bio: "Semiconductor supply-chain research Agent",
            discovery_tags: ["semiconductors", "supply-chain"],
            status: "active",
            created_at: "2026-07-20T14:00:00.000Z",
            activated_at: "2026-07-21T15:00:00.000Z",
          },
        },
      ],
    });
  });

  it("redacts extra and private source fields without reading their accessors", () => {
    const secret = "owner-private-credential-token";
    let privateGetterRead = false;
    const human = Object.assign(humanIdentity(), {
      email: "private-owner@example.test",
      credential: secret,
    });
    Object.defineProperty(human, "sessionCookie", {
      enumerable: true,
      get() {
        privateGetterRead = true;
        return secret;
      },
    });
    const agent = Object.assign(agentIdentity(), {
      credentialHash: secret,
      ownerEmail: "private-owner@example.test",
    });

    const response = projectOwnerAvailablePublicIdentities(
      [human, agent],
      "req-redaction",
    );
    const serialized = JSON.stringify(response);

    expect(privateGetterRead).toBe(false);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("private-owner@example.test");
    expect(serialized).not.toContain("credential");
    expect(serialized).not.toContain("sessionCookie");
    expect(response.identities[0]?.profile).not.toHaveProperty("agentId");
    expect(response.identities[0]?.profile).not.toHaveProperty("discoveryTags");
    expect(response.identities[0]?.profile).not.toHaveProperty("joinedAt");
    expect(response.identities[1]?.profile).not.toHaveProperty("updatedAt");
    expect(response.identities[1]?.profile).not.toHaveProperty("updated_at");
  });

  it.each([
    ["human createdAt", humanIdentity({ createdAt: new Date(Number.NaN) })],
    ["human updatedAt", humanIdentity({ updatedAt: new Date(Number.NaN) })],
    ["Agent createdAt", agentIdentity({ createdAt: new Date(Number.NaN) })],
    ["Agent joinedAt", agentIdentity({ joinedAt: new Date(Number.NaN) })],
  ] satisfies Array<[string, OwnerPublicIdentityView]>)(
    "rejects an invalid %s timestamp without serializing it",
    (_label, identity) => {
      expect(() =>
        projectOwnerAvailablePublicIdentities([identity], "req-invalid-time"),
      ).toThrow("The Owner public identity projection is invalid.");
    },
  );

  it("rejects output values that the public schema would silently normalize", () => {
    expect(() =>
      projectOwnerAvailablePublicIdentities(
        [humanIdentity({ displayName: "  Alpha Researcher  " })],
        "req-normalization-drift",
      ),
    ).toThrow("The Owner public identity projection is invalid.");
  });

  it("rejects duplicate Actor IDs", () => {
    expect(() =>
      projectOwnerAvailablePublicIdentities(
        [humanIdentity(), agentIdentity({ actorId: ids.humanActor })],
        "req-duplicate-actor",
      ),
    ).toThrow();
  });

  it("rejects duplicate Agent IDs", () => {
    expect(() =>
      projectOwnerAvailablePublicIdentities(
        [agentIdentity(), agentIdentity({ actorId: ids.otherActor })],
        "req-duplicate-agent",
      ),
    ).toThrow();
  });

  it("rejects an invalid envelope instead of returning schema drift", () => {
    expect(() => projectOwnerAvailablePublicIdentities([humanIdentity()], "")).toThrow();
  });
});
