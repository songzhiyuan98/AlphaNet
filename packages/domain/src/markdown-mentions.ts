import { fromMarkdown } from "mdast-util-from-markdown";

const DEFAULT_MENTION_LIMIT = 100;
const MAX_MARKDOWN_LINES = 4_096;
const MAX_MARKDOWN_STRUCTURE_TOKENS = 1_024;
const handleCharacter = /[a-zA-Z0-9_.-]/;
const handleEdgeCharacter = /[a-zA-Z0-9]/;
const mentionBoundaryCharacter = /[\p{L}\p{N}_@]/u;

interface MarkdownNode {
  children?: MarkdownNode[] | undefined;
  position?:
    | {
        end?: { offset?: number | undefined } | undefined;
        start?: { offset?: number | undefined } | undefined;
      }
    | undefined;
  type: string;
  value?: string | undefined;
}

interface TextRange {
  end: number;
  start: number;
}

export class MarkdownMentionLimitError extends Error {
  constructor(readonly limit: number) {
    super(`Markdown contains more than ${limit} distinct mention candidates.`);
    this.name = "MarkdownMentionLimitError";
  }
}

export class MarkdownComplexityLimitError extends Error {
  constructor() {
    super("Markdown structural complexity exceeds the safe parsing budget.");
    this.name = "MarkdownComplexityLimitError";
  }
}

/**
 * Extract canonical Actor handles from rendered CommonMark phrasing text.
 *
 * Formatting nodes are flattened before scanning so mention boundaries cannot
 * be changed with emphasis. Code, block HTML, definitions, image destinations,
 * and link destinations never enter the phrasing flow. Inline HTML markup is
 * ignored while its visible surrounding text remains contiguous. URL spans are
 * removed from each flow before bounded, canonical mention collection.
 */
export function extractMarkdownMentionHandles(
  markdown: string,
  limit = DEFAULT_MENTION_LIMIT,
): string[] {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError("The Markdown mention limit must be a non-negative integer.");
  }
  assertMarkdownComplexity(markdown);

  const root = fromMarkdown(markdown) as MarkdownNode;
  const found: string[] = [];
  const seen = new Set<string>();
  for (const text of phrasingFlows(root, markdown)) {
    collectTextMentions(text, findBareUrlRanges(text), limit, found, seen);
  }
  return found;
}

function assertMarkdownComplexity(markdown: string): void {
  let lines = 1;
  let structureTokens = 0;
  for (let index = 0; index < markdown.length; index += 1) {
    const character = markdown[index]!;
    if (character === "\n") {
      lines += 1;
      if (lines > MAX_MARKDOWN_LINES) throw new MarkdownComplexityLimitError();
      continue;
    }
    if (
      character === "`" ||
      character === "*" ||
      character === "_" ||
      character === "~" ||
      character === "!" ||
      character === "&" ||
      character === "\\" ||
      character === "#" ||
      character === "=" ||
      ((character === "-" || character === "+") &&
        isPotentialListBullet(markdown, index)) ||
      (character === "." && isPotentialOrderedListMarker(markdown, index)) ||
      character === "[" ||
      character === "]" ||
      character === "(" ||
      character === ")" ||
      character === "<" ||
      character === ">"
    ) {
      structureTokens += 1;
      if (structureTokens > MAX_MARKDOWN_STRUCTURE_TOKENS) {
        throw new MarkdownComplexityLimitError();
      }
    }
  }
}

function isPotentialListBullet(markdown: string, index: number): boolean {
  return (
    (index === 0 || /\s/u.test(markdown[index - 1]!)) &&
    /[\t ]/u.test(markdown[index + 1] ?? "")
  );
}

function isPotentialOrderedListMarker(markdown: string, index: number): boolean {
  return (
    /[0-9]/u.test(markdown[index - 1] ?? "") && /[\t ]/u.test(markdown[index + 1] ?? "")
  );
}

function phrasingFlows(root: MarkdownNode, markdown: string): string[] {
  const flows: string[] = [];
  let pieces: string[] = [];

  const flush = (): void => {
    if (pieces.length > 0) flows.push(pieces.join(""));
    pieces = [];
  };

  const walkInline = (node: MarkdownNode): void => {
    if (node.type === "text" && typeof node.value === "string") {
      pieces.push(sourceSlice(node, markdown) ?? node.value);
      return;
    }
    if (node.type === "emphasis" || node.type === "strong") {
      for (const child of node.children ?? []) walkInline(child);
      return;
    }
    if (node.type === "link" || node.type === "linkReference") {
      flush();
      if (!isAutolink(node, markdown)) {
        for (const child of node.children ?? []) walkInline(child);
      }
      flush();
      return;
    }
    if (node.type === "html") {
      // Inline HTML markup is not mention-bearing, but it does not insert a
      // visible boundary between adjacent phrasing text either.
      return;
    }
    flush();
  };

  const walkBlock = (node: MarkdownNode): void => {
    if (node.type === "paragraph" || node.type === "heading") {
      for (const child of node.children ?? []) walkInline(child);
      flush();
      return;
    }
    flush();
    for (const child of node.children ?? []) walkBlock(child);
    flush();
  };

  walkBlock(root);
  return flows;
}

function sourceSlice(node: MarkdownNode, markdown: string): string | null {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  return typeof start === "number" && typeof end === "number"
    ? markdown.slice(start, end)
    : null;
}

function isAutolink(node: MarkdownNode, markdown: string): boolean {
  const source = sourceSlice(node, markdown);
  return source !== null && source.startsWith("<") && source.endsWith(">");
}

function collectTextMentions(
  text: string,
  bareUrlRanges: readonly TextRange[],
  limit: number,
  found: string[],
  seen: Set<string>,
): void {
  let index = 0;
  let urlRangeIndex = 0;
  while (index < text.length) {
    while (
      urlRangeIndex < bareUrlRanges.length &&
      bareUrlRanges[urlRangeIndex]!.end <= index
    ) {
      urlRangeIndex += 1;
    }
    const urlRange = bareUrlRanges[urlRangeIndex];
    if (urlRange && urlRange.start <= index) {
      index = urlRange.end;
      continue;
    }
    if (text[index] === "\\") {
      index = Math.min(text.length, index + 2);
      continue;
    }
    if (text[index] !== "@" || !hasMentionBoundary(text, index)) {
      index += 1;
      continue;
    }

    let tokenEnd = index + 1;
    while (tokenEnd < text.length && handleCharacter.test(text[tokenEnd]!)) {
      tokenEnd += 1;
    }
    let candidateEnd = tokenEnd;
    while (
      candidateEnd > index + 1 &&
      !handleEdgeCharacter.test(text[candidateEnd - 1]!)
    ) {
      candidateEnd -= 1;
    }
    const candidate = text.slice(index + 1, candidateEnd);
    if (
      candidate.length >= 3 &&
      candidate.length <= 32 &&
      handleEdgeCharacter.test(candidate[0]!)
    ) {
      const canonical = candidate.toLocaleLowerCase("en-US");
      if (!seen.has(canonical)) {
        if (found.length === limit) throw new MarkdownMentionLimitError(limit);
        seen.add(canonical);
        found.push(canonical);
      }
    }
    index = Math.max(tokenEnd, index + 1);
  }
}

function findBareUrlRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  let index = 0;
  while (index < text.length) {
    const end = skipBareUrl(text, index);
    if (end === null) {
      index += 1;
    } else {
      ranges.push({ end, start: index });
      index = end;
    }
  }
  return ranges;
}

function skipBareUrl(text: string, start: number): number | null {
  const first = text[start]?.toLocaleLowerCase("en-US");
  if (first !== "h" && first !== "m" && first !== "w") return null;
  if (!hasUrlBoundary(text, start)) return null;

  const prefix = text.slice(start, start + 8).toLocaleLowerCase("en-US");
  if (
    !prefix.startsWith("https://") &&
    !prefix.startsWith("http://") &&
    !prefix.startsWith("mailto:") &&
    !prefix.startsWith("www.")
  ) {
    return null;
  }

  let end = start;
  while (end < text.length && !/[\s<>"']/u.test(text[end]!)) end += 1;
  return end;
}

function hasUrlBoundary(text: string, start: number): boolean {
  if (start === 0) return true;
  return !/[\p{L}\p{N}_.-]/u.test(previousCodePoint(text, start));
}

function hasMentionBoundary(text: string, at: number): boolean {
  let boundaryEnd = at;
  while (
    boundaryEnd > 0 &&
    (text[boundaryEnd - 1] === "*" ||
      text[boundaryEnd - 1] === "_" ||
      text[boundaryEnd - 1] === "~" ||
      text[boundaryEnd - 1] === "`")
  ) {
    boundaryEnd -= 1;
  }
  if (boundaryEnd === 0) return true;
  return !mentionBoundaryCharacter.test(previousCodePoint(text, boundaryEnd));
}

function previousCodePoint(value: string, end: number): string {
  let start = end - 1;
  const last = value.charCodeAt(start);
  if (last >= 0xdc00 && last <= 0xdfff && start > 0) {
    const first = value.charCodeAt(start - 1);
    if (first >= 0xd800 && first <= 0xdbff) start -= 1;
  }
  return value.slice(start, end);
}
