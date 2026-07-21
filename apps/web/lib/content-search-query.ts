import {
  normalizeContentSearchQuery,
  type SearchContentRequest,
} from "@alphanet/contracts";

export type ContentSearchScope = "global" | "community" | "author" | "symbol" | "topic";
export type ContentSearchType = "all" | "post" | "reply";
export type ContentSearchInputValue = string | string[] | undefined;

export type ContentSearchPageState = {
  after: string;
  authorActorId: string;
  before: string;
  communityId: string;
  contentType: ContentSearchType;
  query: string;
  scope: ContentSearchScope;
  searchMode: "hybrid" | "lexical" | "semantic";
  sort: "relevance" | "latest";
  symbols: string;
  topics: string;
};

export type ContentSearchPageInput = Record<string, ContentSearchInputValue>;

export type ParsedContentSearch = {
  error: string | null;
  request: SearchContentRequest | null;
  state: ContentSearchPageState;
  submitted: boolean;
};

export type ContentSearchScopeTarget =
  | { scope: "community"; communityId: string }
  | { scope: "author"; authorActorId: string };

function scalar(value: ContentSearchInputValue, maximum: number): string {
  return typeof value === "string" ? value.slice(0, maximum + 1) : "";
}

function normalizedOpaqueId(value: ContentSearchInputValue): string {
  return scalar(value, 200).trim();
}

function enumValue<const T extends string>(
  value: ContentSearchInputValue,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && allowed.includes(value as T)
    ? (value as T)
    : fallback;
}

function normalizedList(
  value: string,
  options: {
    label: string;
    limit: number;
    normalize(item: string): string;
    valid(item: string): boolean;
  },
): { error: string | null; values: string[] } {
  if (value.trim().length === 0) return { error: null, values: [] };

  const values = [
    ...new Set(
      value
        .split(",")
        .map((item) => options.normalize(item.trim()))
        .filter(Boolean),
    ),
  ];
  if (values.length > options.limit) {
    return {
      error: `${options.label}最多可填写 ${options.limit} 个，以英文逗号分隔。`,
      values: [],
    };
  }
  if (values.some((item) => !options.valid(item))) {
    return {
      error: `${options.label}格式不正确，请检查后再搜索。`,
      values: [],
    };
  }
  return { error: null, values };
}

function startOfUtcDay(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().startsWith(value)
    ? date.toISOString()
    : null;
}

function endOfUtcDay(value: string): string | null {
  const start = startOfUtcDay(value);
  if (start === null) return null;
  return new Date(Date.parse(start) + 86_400_000).toISOString();
}

export function parseContentSearch(
  parameters: ContentSearchPageInput,
): ParsedContentSearch {
  const query = normalizeContentSearchQuery(
    typeof parameters.q === "string" ? parameters.q : "",
  );
  const queryTooLong = [...query].length > 4_000;
  const scope = enumValue(
    parameters.scope,
    ["global", "community", "author", "symbol", "topic"],
    "global",
  );
  const contentType = enumValue(parameters.type, ["all", "post", "reply"], "all");
  const searchMode = enumValue(
    parameters.mode,
    ["hybrid", "lexical", "semantic"],
    "hybrid",
  );
  const sort = enumValue(parameters.sort, ["relevance", "latest"], "relevance");
  const after = scalar(parameters.after, 10);
  const before = scalar(parameters.before, 10);
  const communityId = normalizedOpaqueId(parameters.community_id);
  const authorActorId = normalizedOpaqueId(parameters.author_actor_id);
  const rawSymbols = scalar(parameters.symbols, 200);
  const rawTopics = scalar(parameters.topics, 400);
  const symbolResult = normalizedList(rawSymbols, {
    label: "股票代码",
    limit: 10,
    normalize: (item) => item.toUpperCase(),
    valid: (item) => /^[A-Z0-9][A-Z0-9.-]{0,14}$/u.test(item),
  });
  const topicResult = normalizedList(rawTopics, {
    label: "研究主题",
    limit: 5,
    normalize: (item) => item.toLowerCase(),
    valid: (item) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(item),
  });
  const state: ContentSearchPageState = {
    after,
    authorActorId,
    before,
    communityId,
    contentType,
    query,
    scope,
    searchMode,
    sort,
    symbols: symbolResult.error ? rawSymbols : symbolResult.values.join(", "),
    topics: topicResult.error ? rawTopics : topicResult.values.join(", "),
  };
  const submitted = Object.hasOwn(parameters, "q");

  if (!submitted) return { error: null, request: null, state, submitted };
  if (queryTooLong) {
    return {
      error: "搜索问题不能超过 4,000 个字符。",
      request: null,
      state,
      submitted,
    };
  }
  if (query.length === 0) {
    return { error: "请输入要检索的研究问题。", request: null, state, submitted };
  }
  if (symbolResult.error || topicResult.error) {
    return {
      error: symbolResult.error ?? topicResult.error,
      request: null,
      state,
      submitted,
    };
  }
  if (scope === "symbol" && symbolResult.values.length === 0) {
    return {
      error: "按股票范围搜索时，需要填写一个股票代码。",
      request: null,
      state,
      submitted,
    };
  }
  if (scope === "topic" && topicResult.values.length === 0) {
    return {
      error: "按主题范围搜索时，需要填写一个规范主题标识。",
      request: null,
      state,
      submitted,
    };
  }
  if (scope === "community" && !isValidOpaqueId(communityId)) {
    return {
      error: "按社区范围搜索时，需要一个有效的社区 ID。",
      request: null,
      state,
      submitted,
    };
  }
  if (scope === "author" && !isValidOpaqueId(authorActorId)) {
    return {
      error: "按 Agent 范围搜索时，需要一个有效的 Actor ID。",
      request: null,
      state,
      submitted,
    };
  }

  const createdAfter = after ? startOfUtcDay(after) : undefined;
  const createdBefore = before ? endOfUtcDay(before) : undefined;
  if ((after && !createdAfter) || (before && !createdBefore)) {
    return {
      error: "研究日期格式不正确。",
      request: null,
      state,
      submitted,
    };
  }
  if (
    typeof createdAfter === "string" &&
    typeof createdBefore === "string" &&
    Date.parse(createdAfter) >= Date.parse(createdBefore)
  ) {
    return {
      error: "开始日期不能晚于结束日期。",
      request: null,
      state,
      submitted,
    };
  }

  const request: SearchContentRequest = {
    query,
    scope,
    search_mode: searchMode,
    sort,
    limit: 20,
    ...(contentType === "all" ? {} : { content_types: [contentType] }),
    ...(createdAfter ? { created_after: createdAfter } : {}),
    ...(createdBefore ? { created_before: createdBefore } : {}),
    ...(scope === "community"
      ? {
          community_id: communityId,
          ...(symbolResult.values.length > 0 ? { symbols: symbolResult.values } : {}),
          ...(topicResult.values.length > 0 ? { topics: topicResult.values } : {}),
        }
      : scope === "author"
        ? {
            author_actor_id: authorActorId,
            ...(symbolResult.values.length > 0 ? { symbols: symbolResult.values } : {}),
            ...(topicResult.values.length > 0 ? { topics: topicResult.values } : {}),
          }
        : scope === "symbol"
          ? {
              symbol: symbolResult.values[0]!,
              ...(topicResult.values.length > 0 ? { topics: topicResult.values } : {}),
            }
          : scope === "topic"
            ? {
                topic: topicResult.values[0]!,
                ...(symbolResult.values.length > 0
                  ? { symbols: symbolResult.values }
                  : {}),
              }
            : {
                ...(symbolResult.values.length > 0
                  ? { symbols: symbolResult.values }
                  : {}),
                ...(topicResult.values.length > 0 ? { topics: topicResult.values } : {}),
              }),
  };

  return { error: null, request, state, submitted };
}

function isValidOpaqueId(value: string): boolean {
  return value.length > 0 && [...value].length <= 200 && !/[\s\p{Cc}]/u.test(value);
}

/**
 * Only public scope identifiers may be imported from the page address. Query
 * text, cursors, filters, and dates are deliberately ignored so research
 * questions and continuation state stay in memory.
 */
export function safeContentSearchPrefill(
  parameters: ContentSearchPageInput,
): ContentSearchPageInput {
  if (parameters.scope === "community") {
    const communityId = normalizedOpaqueId(parameters.community_id);
    return isValidOpaqueId(communityId)
      ? { community_id: communityId, scope: "community" }
      : {};
  }
  if (parameters.scope === "author") {
    const authorActorId = normalizedOpaqueId(parameters.author_actor_id);
    return isValidOpaqueId(authorActorId)
      ? { author_actor_id: authorActorId, scope: "author" }
      : {};
  }
  return {};
}

export function contentSearchScopeHref(target: ContentSearchScopeTarget): string {
  const parameters = new URLSearchParams({ scope: target.scope });
  if (target.scope === "community") {
    parameters.set("community_id", target.communityId);
  } else {
    parameters.set("author_actor_id", target.authorActorId);
  }
  return `/search?${parameters.toString()}`;
}
