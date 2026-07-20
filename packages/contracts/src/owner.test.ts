import { describe, expect, it } from "vitest";

import { OwnerSessionResponseSchema } from "./owner.js";

describe("OwnerSessionResponseSchema", () => {
  const response = {
    owner: {
      id: "00000000-0000-4000-8000-000000000001",
      email: "owner@example.com",
      name: "Research Owner",
      emailVerified: true,
      status: "active",
    },
    session: {
      id: "00000000-0000-4000-8000-000000000002",
      expiresAt: "2026-07-27T12:00:00.000Z",
    },
  } as const;

  it("accepts the stable public Owner session projection", () => {
    expect(OwnerSessionResponseSchema.parse(response)).toEqual(response);
  });

  it("rejects Better Auth internals and unrecognized platform states", () => {
    expect(
      OwnerSessionResponseSchema.safeParse({
        ...response,
        owner: {
          ...response.owner,
          authUserId: "00000000-0000-4000-8000-000000000003",
        },
      }).success,
    ).toBe(false);
    expect(
      OwnerSessionResponseSchema.safeParse({
        ...response,
        owner: { ...response.owner, status: "admin" },
      }).success,
    ).toBe(false);
  });
});
