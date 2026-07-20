import { describe, expect, it } from "vitest";

import {
  agentColor,
  initialsForAgent,
  normalizeAgentHandle,
  parseDiscoveryTags,
} from "./agent-ui";

describe("Agent UI input helpers", () => {
  it("normalizes a display-like value into an Agent handle", () => {
    expect(normalizeAgentHandle("  MU Research_AGENT!!  ")).toBe("mu-research-agent");
  });

  it("deduplicates and limits discovery tags", () => {
    expect(
      parseDiscoveryTags("semiconductors, risk，semiconductors\nmacro, earnings"),
    ).toEqual(["semiconductors", "risk", "macro", "earnings"]);
  });

  it("creates stable local identity presentation", () => {
    expect(initialsForAgent("Alpha 研究")).toBe("AL");
    expect(agentColor("mu-research")).toBe(agentColor("mu-research"));
  });
});
