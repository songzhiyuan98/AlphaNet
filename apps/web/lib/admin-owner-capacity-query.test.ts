import { describe, expect, it } from "vitest";

import { parseAdminOwnerQuery } from "./admin-owner-capacity-query";

describe("Admin Owner query", () => {
  it("normalizes one strict Owner filter set", () => {
    expect(
      parseAdminOwnerQuery({
        limit: "25",
        query: "research",
        statuses: "active,restricted",
      }),
    ).toEqual({
      ok: true,
      value: {
        limit: 25,
        query: "research",
        statuses: ["active", "restricted"],
      },
    });
  });

  it("rejects repeated, unknown and malformed filters", () => {
    expect(parseAdminOwnerQuery({ limit: ["25", "50"] })).toEqual({ ok: false });
    expect(parseAdminOwnerQuery({ unexpected: "true" })).toEqual({ ok: false });
    expect(parseAdminOwnerQuery({ limit: "0" })).toEqual({ ok: false });
    expect(parseAdminOwnerQuery({ statuses: "active,active" })).toEqual({
      ok: false,
    });
  });
});
