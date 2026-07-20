import { describe, expect, it } from "vitest";

import {
  digestResearchCommand,
  normalizeCreatePostCommand,
  normalizeReplyCommand,
} from "./research-command.js";
import type { ResearchCommandValidationError } from "./research-command.js";

const communityId = "00000000-0000-4000-8000-000000000101";
const additionalCommunityId = "00000000-0000-4000-8000-000000000102";
const parentContentId = "00000000-0000-4000-8000-000000000201";

describe("research command normalization", () => {
  it("produces one canonical create-post command and stable digest", () => {
    const first = normalizeCreatePostCommand({
      title: "  AMD data-center scenarios  ",
      bodyMarkdown: "## Base\r\n\r\nRevenue grows 18%.\r\n",
      primaryCommunityId: communityId,
      additionalCommunityIds: [additionalCommunityId],
      symbols: [" amd ", "AMD"],
      topics: [" Scenario-Analysis ", "data-center"],
      sourceLinks: [
        {
          url: "https://IR.AMD.com:443/example#section",
          title: " Investor update ",
        },
        {
          url: "https://ir.amd.com/example#section",
          title: "Investor update",
        },
      ],
      references: [
        { targetContentId: parentContentId, relationType: "quote" },
        { targetContentId: parentContentId, relationType: "quote" },
      ],
    });
    const second = normalizeCreatePostCommand({
      title: "AMD data-center scenarios",
      bodyMarkdown: "## Base\n\nRevenue grows 18%.\n",
      primaryCommunityId: communityId,
      additionalCommunityIds: [additionalCommunityId],
      symbols: ["AMD"],
      topics: ["data-center", "scenario-analysis"],
      sourceLinks: [
        {
          url: "https://ir.amd.com/example#section",
          title: "Investor update",
        },
      ],
      references: [{ targetContentId: parentContentId, relationType: "quote" }],
    });

    expect(first).toEqual(second);
    expect(first.sourceLinks).toHaveLength(1);
    expect(first.symbols).toEqual(["AMD"]);
    expect(first.topics).toEqual(["data-center", "scenario-analysis"]);
    expect(digestResearchCommand(first)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(digestResearchCommand(first)).toBe(digestResearchCommand(second));
  });

  it("keeps create and reply digests in separate command domains", () => {
    const post = normalizeCreatePostCommand({
      title: "A valid research title",
      bodyMarkdown: "Same body",
      primaryCommunityId: communityId,
    });
    const reply = normalizeReplyCommand({
      parentContentId,
      bodyMarkdown: "Same body",
    });

    expect(digestResearchCommand(post)).not.toBe(digestResearchCommand(reply));
  });

  it("rejects duplicate community targets instead of silently changing routing", () => {
    expect(() =>
      normalizeCreatePostCommand({
        title: "A valid research title",
        bodyMarkdown: "Research body",
        primaryCommunityId: communityId,
        additionalCommunityIds: [communityId],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ResearchCommandValidationError>>({
        code: "DUPLICATE_COMMUNITY_TARGET",
      }),
    );
  });

  it("canonicalizes UUID casing before routing and digest comparisons", () => {
    const lowerCommunityId = "abcdefab-cdef-4abc-8def-abcdefabcdef";
    const upperCommunityId = lowerCommunityId.toUpperCase();

    expect(() =>
      normalizeCreatePostCommand({
        title: "A valid research title",
        bodyMarkdown: "Research body",
        primaryCommunityId: lowerCommunityId,
        additionalCommunityIds: [upperCommunityId],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ResearchCommandValidationError>>({
        code: "DUPLICATE_COMMUNITY_TARGET",
      }),
    );

    const lower = normalizeReplyCommand({
      parentContentId: lowerCommunityId,
      bodyMarkdown: "Research body",
      references: [{ targetContentId: lowerCommunityId, relationType: "reference" }],
    });
    const upper = normalizeReplyCommand({
      parentContentId: upperCommunityId,
      bodyMarkdown: "Research body",
      references: [{ targetContentId: upperCommunityId, relationType: "reference" }],
    });

    expect(upper).toEqual(lower);
    expect(digestResearchCommand(upper)).toBe(digestResearchCommand(lower));
  });

  it("rejects PostgreSQL-incompatible NUL without rejecting normal layout controls", () => {
    expect(() =>
      normalizeReplyCommand({
        parentContentId,
        bodyMarkdown: "Research\u0000body",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ResearchCommandValidationError>>({
        code: "TEXT_INVALID",
      }),
    );

    expect(
      normalizeReplyCommand({
        parentContentId,
        bodyMarkdown: "Line one\n\tLine two",
      }).bodyMarkdown,
    ).toBe("Line one\n\tLine two");
  });

  it("rejects conflicting metadata for the same normalized source URL", () => {
    expect(() =>
      normalizeReplyCommand({
        parentContentId,
        bodyMarkdown: "Research body",
        sourceLinks: [
          { url: "https://example.test/source#fragment", title: "First" },
          { url: "https://EXAMPLE.test:443/source#fragment", title: "Second" },
        ],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ResearchCommandValidationError>>({
        code: "SOURCE_LINK_CONFLICT",
      }),
    );
  });

  it("rejects non-HTTPS sources without making a network request", () => {
    expect(() =>
      normalizeReplyCommand({
        parentContentId,
        bodyMarkdown: "Research body",
        sourceLinks: [{ url: "http://example.test/source" }],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ResearchCommandValidationError>>({
        code: "SOURCE_URL_INVALID",
      }),
    );
  });

  it("preserves distinct URL fragments as exact research citations", () => {
    const normalized = normalizeReplyCommand({
      parentContentId,
      bodyMarkdown: "Research body",
      sourceLinks: [
        { url: "https://example.test/report#risk-factors" },
        { url: "https://example.test/report#financial-statements" },
      ],
    });

    expect(normalized.sourceLinks.map((source) => source.url)).toEqual([
      "https://example.test/report#financial-statements",
      "https://example.test/report#risk-factors",
    ]);
  });
});
