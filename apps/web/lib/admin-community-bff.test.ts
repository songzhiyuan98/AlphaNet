import { describe, expect, it } from "vitest";

import {
  parseAdminCommunityCreateBffRequest,
  parseAdminCommunityUpdateBffRequest,
  readAdminCommunityBffJson,
} from "./admin-community-bff";
import { parseAdminCommunityQuery } from "./admin-community-query";

const attemptId = "10000000-0000-4000-8000-000000000001";

describe("Admin community browser boundary", () => {
  it("accepts only strict create and optimistic-concurrency update bodies", () => {
    expect(
      parseAdminCommunityCreateBffRequest({
        attempt_id: attemptId,
        community: { name: "Semiconductors", slug: "semiconductors" },
      }),
    ).toMatchObject({ attemptId, community: { slug: "semiconductors" } });
    expect(
      parseAdminCommunityUpdateBffRequest({
        attempt_id: attemptId,
        community_version: 3,
        patch: { state: "archived" },
      }),
    ).toEqual({
      attemptId,
      communityVersion: 3,
      patch: { state: "archived" },
    });
    expect(
      parseAdminCommunityUpdateBffRequest({
        attempt_id: attemptId,
        community_version: 3,
        idempotency_key: "browser-controlled",
        patch: { state: "archived" },
      }),
    ).toBeNull();
  });

  it("bounds JSON input and rejects non-JSON requests", async () => {
    const valid = new Request("https://app.alphanet.test/admin/communities/actions", {
      body: JSON.stringify({ attempt_id: attemptId }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await expect(readAdminCommunityBffJson(valid)).resolves.toEqual({
      attempt_id: attemptId,
    });
    const invalid = new Request("https://app.alphanet.test/admin/communities/actions", {
      body: "{}",
      headers: { "content-type": "text/plain" },
      method: "POST",
    });
    await expect(readAdminCommunityBffJson(invalid)).resolves.toBeNull();
  });

  it("parses only canonical list filters", () => {
    expect(
      parseAdminCommunityQuery({
        limit: "25",
        query: "semi",
        states: "active,archived",
      }),
    ).toEqual({
      ok: true,
      value: {
        limit: 25,
        query: "semi",
        states: ["active", "archived"],
      },
    });
    expect(parseAdminCommunityQuery({ states: ["active", "archived"] })).toEqual({
      ok: false,
    });
    expect(parseAdminCommunityQuery({ unexpected: "true" })).toEqual({
      ok: false,
    });
  });
});
