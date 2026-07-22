import { describe, expect, it } from "vitest";

import { parseAdminCaseDetailQuery, parseAdminModerationQueueQuery } from "./admin-query";

describe("Admin Web query parsing", () => {
  it("uses the actionable queue and bounded page sizes by default", () => {
    expect(parseAdminModerationQueueQuery({})).toEqual({
      ok: true,
      value: {
        limit: 20,
        statuses: ["open", "reviewing"],
      },
    });
    expect(parseAdminCaseDetailQuery({})).toEqual({
      ok: true,
      value: { action_limit: 20, report_limit: 20 },
    });
  });

  it("normalizes repeated Web form values and comma-delimited deep links", () => {
    expect(
      parseAdminModerationQueueQuery({
        content_id: "content-42",
        cursor: "opaque-cursor",
        limit: "50",
        priorities: ["urgent", "high"],
        reasons: "privacy_exposure,malicious_link",
        statuses: ["open", "reviewing"],
      }),
    ).toEqual({
      ok: true,
      value: {
        content_id: "content-42",
        cursor: "opaque-cursor",
        limit: 50,
        priorities: ["urgent", "high"],
        reasons: ["privacy_exposure", "malicious_link"],
        statuses: ["open", "reviewing"],
      },
    });

    expect(
      parseAdminModerationQueueQuery({
        content_id: "",
        limit: "20",
        statuses: ["open", "reviewing"],
      }),
    ).toEqual({
      ok: true,
      value: { limit: 20, statuses: ["open", "reviewing"] },
    });
  });

  it("rejects duplicate, unknown, ambiguous, and malformed queue input", () => {
    for (const query of [
      { unknown: "true" },
      { statuses: "open,open" },
      { statuses: "open,,reviewing" },
      { statuses: "not-a-status" },
      { cursor: ["one", "two"] },
      { limit: "01" },
      { limit: "101" },
      { content_id: "content id" },
    ]) {
      expect(parseAdminModerationQueueQuery(query)).toEqual({ ok: false });
    }
  });

  it("parses independent report and action pagination without ambiguity", () => {
    expect(
      parseAdminCaseDetailQuery({
        action_cursor: "actions-page-2",
        action_limit: "10",
        report_cursor: "reports-page-3",
        report_limit: "50",
      }),
    ).toEqual({
      ok: true,
      value: {
        action_cursor: "actions-page-2",
        action_limit: 10,
        report_cursor: "reports-page-3",
        report_limit: 50,
      },
    });

    expect(parseAdminCaseDetailQuery({ report_cursor: ["one", "two"] })).toEqual({
      ok: false,
    });
    expect(parseAdminCaseDetailQuery({ action_limit: "0" })).toEqual({
      ok: false,
    });
  });
});
