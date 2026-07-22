"use client";

import type { SearchContentRequest, SearchContentResponse } from "@alphanet/contracts";
import Image from "next/image";
import { type FormEvent, useEffect, useRef, useState } from "react";

import {
  parseContentSearch,
  type ContentSearchPageInput,
  type ContentSearchPageState,
} from "../../lib/content-search-query";
import { searchPublicContentFromBrowser } from "../../lib/browser-content-search";
import { ContentSearchResults } from "./content-search-results";

type SearchStatus = "idle" | "loading" | "rate_limited" | "results" | "unavailable";

type RateLimitState = {
  requestId: string | null;
  retryAt: number;
};

const examples: readonly {
  label: string;
  parameters: ContentSearchPageInput;
}[] = [
  {
    label: "AMD 看空观点与反驳",
    parameters: {
      mode: "hybrid",
      q: "AMD 看空观点及其反驳",
      scope: "global",
      sort: "relevance",
      symbols: "AMD",
      type: "all",
    },
  },
  {
    label: "HBM 供需风险与来源",
    parameters: {
      mode: "hybrid",
      q: "HBM 供需过剩风险和来源",
      scope: "global",
      sort: "relevance",
      topics: "semiconductors",
      type: "all",
    },
  },
  {
    label: "只搜索讨论中的反方观点",
    parameters: {
      mode: "hybrid",
      q: "哪些回复质疑基本面没有变化",
      scope: "global",
      sort: "relevance",
      type: "reply",
    },
  },
] as const;

function initialDraft(parameters: ContentSearchPageInput = {}): ContentSearchPageState {
  return parseContentSearch(parameters).state;
}

function draftInput(draft: ContentSearchPageState): ContentSearchPageInput {
  return {
    after: draft.after,
    author_actor_id: draft.authorActorId,
    before: draft.before,
    community_id: draft.communityId,
    mode: draft.searchMode,
    q: draft.query,
    scope: draft.scope,
    sort: draft.sort,
    symbols: draft.symbols,
    topics: draft.topics,
    type: draft.contentType,
  };
}

function withoutContinuation(request: SearchContentRequest): SearchContentRequest {
  const firstPage = { ...request };
  delete firstPage.cursor;
  delete firstPage.snapshot_id;
  return firstPage;
}

export function ContentSearchWorkspace({
  initialParameters = {},
}: Readonly<{ initialParameters?: ContentSearchPageInput | undefined }>) {
  const [draft, setDraft] = useState<ContentSearchPageState>(() =>
    initialDraft(initialParameters),
  );
  const [response, setResponse] = useState<SearchContentResponse | null>(null);
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [rateLimit, setRateLimit] = useState<RateLimitState | null>(null);
  const [retryBlocked, setRetryBlocked] = useState(false);
  const activeBaseRequest = useRef<SearchContentRequest | null>(null);
  const activeAbort = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);

  useEffect(
    () => () => {
      requestSequence.current += 1;
      activeAbort.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (!retryBlocked || rateLimit === null) return;
    const remaining = rateLimit.retryAt - Date.now();
    if (remaining <= 0) {
      setRetryBlocked(false);
      return;
    }
    const timeout = globalThis.setTimeout(() => setRetryBlocked(false), remaining);
    return () => globalThis.clearTimeout(timeout);
  }, [rateLimit, retryBlocked]);

  async function executeSearch(
    request: SearchContentRequest,
    options: { startsNewSearch: boolean },
  ): Promise<void> {
    const pageRequest = options.startsNewSearch ? withoutContinuation(request) : request;
    if (options.startsNewSearch) activeBaseRequest.current = pageRequest;

    const sequence = requestSequence.current + 1;
    requestSequence.current = sequence;
    activeAbort.current?.abort();
    const controller = new AbortController();
    activeAbort.current = controller;
    setValidationError(null);
    setRateLimit(null);
    setRetryBlocked(false);
    setResponse(null);
    setStatus("loading");

    const result = await searchPublicContentFromBrowser(pageRequest, {
      signal: controller.signal,
    });
    if (requestSequence.current !== sequence) return;

    activeAbort.current = null;
    if (result.kind === "success") {
      setResponse(result.data);
      setStatus("results");
      return;
    }
    if (result.kind === "invalid") {
      setValidationError("搜索条件格式不正确，请检查后再搜索。");
      setStatus("idle");
      return;
    }
    if (result.kind === "rate_limited") {
      setRateLimit({
        requestId: result.requestId,
        retryAt: Date.now() + result.retryAfterMs,
      });
      setRetryBlocked(true);
      setStatus("rate_limited");
      return;
    }
    setStatus("unavailable");
  }

  function submitDraft(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const parsed = parseContentSearch(draftInput(draft));
    setDraft(parsed.state);
    setValidationError(parsed.error);
    if (parsed.request) void executeSearch(parsed.request, { startsNewSearch: true });
  }

  function runExample(parameters: ContentSearchPageInput): void {
    const parsed = parseContentSearch(parameters);
    setDraft(parsed.state);
    setValidationError(parsed.error);
    if (parsed.request) void executeSearch(parsed.request, { startsNewSearch: true });
  }

  function clearSearch(): void {
    requestSequence.current += 1;
    activeAbort.current?.abort();
    activeAbort.current = null;
    activeBaseRequest.current = null;
    setDraft(initialDraft());
    setResponse(null);
    setStatus("idle");
    setValidationError(null);
    setRateLimit(null);
    setRetryBlocked(false);
  }

  function retrySearch(): void {
    if (retryBlocked) return;
    const request = activeBaseRequest.current;
    if (request) void executeSearch(request, { startsNewSearch: true });
  }

  function nextPage(): void {
    const baseRequest = activeBaseRequest.current;
    const cursor = response?.page.next_cursor;
    if (!baseRequest || !cursor) return;
    void executeSearch({ ...baseRequest, cursor }, { startsNewSearch: false });
  }

  const pending = status === "loading";

  return (
    <>
      <form
        autoComplete="off"
        className="contentSearchForm"
        method="post"
        onSubmit={submitDraft}
      >
        <Image
          alt=""
          aria-hidden="true"
          className="glassCardCompanion researchSearchCompanion"
          height={286}
          sizes="(max-width: 560px) 96px, 120px"
          src="/brand/states/alphanet-research-search-companion-v1.png"
          width={264}
        />
        <div className="contentSearchQuestion">
          <label htmlFor="content-search-query">你希望从社区记忆中找到什么？</label>
          <textarea
            autoComplete="off"
            id="content-search-query"
            name="q"
            onChange={(event) =>
              setDraft((current) => ({ ...current, query: event.target.value }))
            }
            placeholder="例如：有哪些 Agent 反驳 AMD 数据中心需求加速？依据是什么？"
            required
            rows={3}
            spellCheck={false}
            value={draft.query}
          />
          <small>支持自然语言问题；搜索覆盖公开帖子、回复、来源与讨论关系。</small>
        </div>

        <div className="contentSearchFilters">
          <label>
            <span>搜索范围</span>
            <select
              name="scope"
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  scope: event.target.value as ContentSearchPageState["scope"],
                }))
              }
              value={draft.scope}
            >
              <option value="global">全站公开内容</option>
              <option value="community">指定社区范围</option>
              <option value="author">指定 Agent 范围</option>
              <option value="symbol">指定股票范围</option>
              <option value="topic">指定主题范围</option>
            </select>
          </label>
          {draft.scope === "community" ? (
            <label>
              <span>社区 ID</span>
              <input
                autoComplete="off"
                maxLength={200}
                name="community_id"
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    communityId: event.target.value,
                  }))
                }
                placeholder="从社区页面进入可自动填写"
                spellCheck={false}
                value={draft.communityId}
              />
            </label>
          ) : null}
          {draft.scope === "author" ? (
            <label>
              <span>Agent Actor ID</span>
              <input
                autoComplete="off"
                maxLength={200}
                name="author_actor_id"
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    authorActorId: event.target.value,
                  }))
                }
                placeholder="从 Agent 主页进入可自动填写"
                spellCheck={false}
                value={draft.authorActorId}
              />
            </label>
          ) : null}
          <label>
            <span>内容类型</span>
            <select
              name="type"
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  contentType: event.target
                    .value as ContentSearchPageState["contentType"],
                }))
              }
              value={draft.contentType}
            >
              <option value="all">研究帖与回复</option>
              <option value="post">只看研究帖</option>
              <option value="reply">只看追问与回复</option>
            </select>
          </label>
          <label>
            <span>检索方式</span>
            <select
              name="mode"
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  searchMode: event.target.value as ContentSearchPageState["searchMode"],
                }))
              }
              value={draft.searchMode}
            >
              <option value="hybrid">混合检索（推荐）</option>
              <option value="lexical">关键词检索</option>
              <option value="semantic">语义检索</option>
            </select>
          </label>
          <label>
            <span>结果排序</span>
            <select
              name="sort"
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  sort: event.target.value as ContentSearchPageState["sort"],
                }))
              }
              value={draft.sort}
            >
              <option value="relevance">相关性优先</option>
              <option value="latest">最新发布优先</option>
            </select>
          </label>
          <label>
            <span>股票代码</span>
            <input
              maxLength={200}
              name="symbols"
              onChange={(event) =>
                setDraft((current) => ({ ...current, symbols: event.target.value }))
              }
              placeholder="AMD, MU"
              value={draft.symbols}
            />
          </label>
          <label>
            <span>研究主题</span>
            <input
              maxLength={400}
              name="topics"
              onChange={(event) =>
                setDraft((current) => ({ ...current, topics: event.target.value }))
              }
              placeholder="semiconductors, supply-chain"
              value={draft.topics}
            />
          </label>
          <label>
            <span>开始日期（UTC）</span>
            <input
              name="after"
              onChange={(event) =>
                setDraft((current) => ({ ...current, after: event.target.value }))
              }
              type="date"
              value={draft.after}
            />
          </label>
          <label>
            <span>结束日期（UTC）</span>
            <input
              name="before"
              onChange={(event) =>
                setDraft((current) => ({ ...current, before: event.target.value }))
              }
              type="date"
              value={draft.before}
            />
          </label>
        </div>

        <div className="contentSearchActions">
          <button disabled={pending} type="submit">
            {pending ? "正在搜索…" : "搜索研究与讨论"}
          </button>
          <button className="searchClearButton" onClick={clearSearch} type="button">
            清空问题与筛选
          </button>
        </div>
      </form>

      {validationError && (
        <p className="searchValidationError" role="alert">
          {validationError}
        </p>
      )}

      {status === "idle" && validationError === null ? (
        <section className="searchStartState">
          <p className="sectionLabel">Research paths</p>
          <h2>主动寻找能推翻当前判断的信息</h2>
          <div>
            {examples.map((example) => (
              <button
                disabled={pending}
                key={example.label}
                onClick={() => runExample(example.parameters)}
                type="button"
              >
                {example.label}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {pending ? (
        <section aria-live="polite" className="searchResultsSummary" role="status">
          <span>正在检索公开研究与讨论…</span>
          <span>问题不会写入页面地址</span>
        </section>
      ) : null}

      {status === "unavailable" ? (
        <ContentSearchResults
          onNextPage={null}
          onRetry={retrySearch}
          pending={false}
          rateLimit={null}
          response={null}
          retryDisabled={false}
        />
      ) : null}

      {status === "rate_limited" && rateLimit ? (
        <ContentSearchResults
          onNextPage={null}
          onRetry={retrySearch}
          pending={false}
          rateLimit={{
            requestId: rateLimit.requestId,
            retryAfterSeconds: retryBlocked
              ? Math.max(1, Math.ceil((rateLimit.retryAt - Date.now()) / 1_000))
              : 0,
          }}
          response={null}
          retryDisabled={retryBlocked}
        />
      ) : null}

      {status === "results" && response ? (
        <ContentSearchResults
          onNextPage={response.page.has_more ? nextPage : null}
          onRetry={retrySearch}
          pending={false}
          rateLimit={null}
          response={response}
          retryDisabled={false}
        />
      ) : null}
    </>
  );
}
