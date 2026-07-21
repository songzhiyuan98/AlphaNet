import { describe, expect, it } from "vitest";

import {
  extractMarkdownMentionHandles,
  MarkdownComplexityLimitError,
  MarkdownMentionLimitError,
} from "./markdown-mentions.js";

describe("Markdown mention extraction", () => {
  it("canonicalizes and de-duplicates handles in visible text", () => {
    expect(
      extractMarkdownMentionHandles(
        "Ask @Market-Scout, then compare @market-scout with @Risk.Agent_2.",
      ),
    ).toEqual(["market-scout", "risk.agent_2"]);
  });

  it("preserves visible mention boundaries across formatting nodes", () => {
    expect(
      extractMarkdownMentionHandles(
        "alpha**@embedded-agent** alpha~~@tilde-agent~~ @risk.**agent** **@macro**.agent @standalone-agent",
      ),
    ).toEqual(["risk.agent", "macro.agent", "standalone-agent"]);
  });

  it("ignores non-text Markdown and URL contexts", () => {
    const markdown = [
      "Visible @Visible-Agent and [ask @Label-Agent](https://example.test/@destination).",
      "",
      "```text",
      "@fenced-agent",
      "```",
      "",
      "~~~",
      "@tilde-agent",
      "~~~",
      "",
      "Inline `@inline-agent` and ``code @long-inline``.",
      "",
      "    @indented-agent",
      "Bare https://example.test/@bare-agent and mailto:@mail-agent.",
      "Split https://example.test/*path*/@split-agent then @after-split-agent.",
      "Split mailto:*path*/@split-mail-agent then @after-mail-agent.",
      "Split www.example.test/*path*/@split-www-agent then @after-www-agent.",
      "IPv6 http://[::1]/@ipv6-agent then @after-ipv6-agent.",
      "Paren https://example.test/path(foo)/@paren-agent then @after-paren-agent.",
      "[https://example.test/*path*/@label-url-agent](https://destination.test)",
      "`https://example.test/@code-url-agent`@after-code-url",
      "[label](https://example.test/@destination-agent)@after-destination",
      "![alt](https://example.test/@image-agent)@after-image",
      "Autolink <https://example.test/@auto-agent>.",
      "Other autolinks <ftp://example.test/@ftp-agent> <tel:@tel-agent>.",
      "Escaped \\@escaped-agent.",
      "[source]: https://example.test/@reference-agent",
      "",
      '<div data-agent="@attribute-agent">',
      "@html-agent",
      "</div>",
      "",
      "After HTML @After-Agent.",
    ].join("\n");

    expect(extractMarkdownMentionHandles(markdown)).toEqual([
      "visible-agent",
      "label-agent",
      "after-split-agent",
      "after-mail-agent",
      "after-www-agent",
      "after-ipv6-agent",
      "after-paren-agent",
      "after-code-url",
      "after-destination",
      "after-image",
      "after-agent",
    ]);
  });

  it("uses CommonMark structure for malformed text, quotes, and HTML blocks", () => {
    const markdown = [
      "2 < 3 and @math-agent > 1",
      "plain ](not-a-link/@plain-agent) @outside-agent",
      "> ~~~text",
      "> @quoted-code",
      "> ~~~",
      "",
      "<custom-element>",
      "@custom-html",
      "",
      "@after-custom-html",
      "",
      "<div>",
      "@standard-html",
      "",
      "@after-standard-html",
      "",
      "Inline HTML keeps visible text: <span>@inside-span</span>.",
    ].join("\n");

    expect(extractMarkdownMentionHandles(markdown)).toEqual([
      "math-agent",
      "plain-agent",
      "outside-agent",
      "after-custom-html",
      "after-standard-html",
      "inside-span",
    ]);
  });

  it("does not extract email fragments, embedded handles, or invalid handle edges", () => {
    expect(
      extractMarkdownMentionHandles(
        "a@company.test alpha@embedded @-bad-edge @@double @ok-agent",
      ),
    ).toEqual(["ok-agent"]);
  });

  it("accepts exactly 100 distinct candidates", () => {
    const markdown = handles(100);
    expect(extractMarkdownMentionHandles(markdown)).toHaveLength(100);
  });

  it("rejects the 101st distinct candidate while allowing duplicates", () => {
    const oneHundred = handles(100);
    expect(
      extractMarkdownMentionHandles(`${oneHundred} @agent-000 @AGENT-000`),
    ).toHaveLength(100);
    expect(() => extractMarkdownMentionHandles(`${oneHundred} @agent-100`)).toThrow(
      MarkdownMentionLimitError,
    );
  });

  it("bounds adversarial input without collecting every candidate", () => {
    expect(() => extractMarkdownMentionHandles(handles(10_000))).toThrowError(
      "Markdown contains more than 100 distinct mention candidates.",
    );
  });

  it("handles a maximum-size malformed-token corpus in bounded time", () => {
    for (const malformed of [
      `${"<x\n".repeat(16_000)}${"plain ](\n".repeat(5_000)}@visible-agent`,
      "*a".repeat(50_000),
      "_a".repeat(50_000),
      "- ".repeat(50_000),
      "+ ".repeat(50_000),
      "1. ".repeat(25_000),
    ]) {
      const startedAt = performance.now();
      expect(() => extractMarkdownMentionHandles(malformed)).toThrow(
        MarkdownComplexityLimitError,
      );
      expect(performance.now() - startedAt).toBeLessThan(500);
    }
  });

  it("maps dense URL and emphasis flows without a pieces-by-ranges cross product", () => {
    const markdown = `${"*x* www.a ".repeat(512)}${"www.a ".repeat(15_000)}`;
    const startedAt = performance.now();

    expect(extractMarkdownMentionHandles(markdown)).toEqual([]);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});

function handles(count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `@agent-${String(index).padStart(3, "0")}`,
  ).join(" ");
}
