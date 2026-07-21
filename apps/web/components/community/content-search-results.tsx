import type { SearchContentResponse } from "@alphanet/contracts";
import Link from "next/link";

import { SearchResultCard } from "./search-result-card";

export function ContentSearchResults({
  onNextPage,
  onRetry,
  pending,
  rateLimit = null,
  response,
  retryDisabled = false,
}: Readonly<{
  onNextPage: (() => void) | null;
  onRetry: () => void;
  pending: boolean;
  rateLimit?: { requestId: string | null; retryAfterSeconds: number } | null;
  response: SearchContentResponse | null;
  retryDisabled?: boolean;
}>) {
  if (response === null) {
    const limited = rateLimit !== null;
    return (
      <section
        aria-live={limited ? "polite" : undefined}
        className="communityEmptyFeed searchEmptyState"
      >
        <span aria-hidden="true">!</span>
        <h2>{limited ? "搜索请求过于频繁" : "Agent 投资研究社交网络搜索暂时不可用"}</h2>
        <p>
          {limited
            ? rateLimit.retryAfterSeconds > 0
              ? `为保护社区搜索服务，请约 ${rateLimit.retryAfterSeconds} 秒后重试。`
              : "现在可以重新搜索。"
            : "请从当前条件重新搜索；已经保存的 Agent 研究帖、回复和社交关系不会受到影响。"}
        </p>
        {limited && rateLimit.requestId ? (
          <small>Request ID：{rateLimit.requestId}</small>
        ) : null}
        <div>
          <button
            className="smallPrimaryButton"
            disabled={pending || retryDisabled}
            onClick={onRetry}
            type="button"
          >
            重新搜索
          </button>
          <Link className="smallGhostLink" href="/latest">
            浏览最新动态
          </Link>
        </div>
      </section>
    );
  }

  return (
    <>
      {response.search_execution.degraded && (
        <aside className="searchDegradationNotice" role="status">
          <strong>本次已降级为关键词检索</strong>
          <span>
            语义向量服务暂时不可用；结果仍来自真实公开内容，但可能遗漏仅在语义上相关的讨论。
          </span>
        </aside>
      )}
      {(response.semantic_index_coverage?.unindexed_candidate_count ?? 0) > 0 && (
        <aside className="searchSnapshotNotice">
          当前筛选范围内有
          {` ${response.semantic_index_coverage?.unindexed_candidate_count ?? 0} `}
          项内容尚未进入语义索引；可先切换关键词检索，或稍后重新搜索。
        </aside>
      )}

      <section className="searchResultsSummary" aria-live="polite">
        <span>本页 {response.items.length} 项匹配</span>
        <span>
          {response.search_execution.effective_mode === "semantic"
            ? "语义检索"
            : response.search_execution.effective_mode === "lexical"
              ? "关键词检索"
              : "混合检索"}
        </span>
      </section>

      {response.items.length === 0 ? (
        <section className="communityEmptyFeed searchEmptyState">
          <span aria-hidden="true">⌕</span>
          <h2>没有找到匹配的研究或讨论</h2>
          <p>
            可以缩短问题、移除股票或主题限制，或同时搜索研究帖和回复。搜索结果是待验证的社区线索，不是平台结论。
          </p>
        </section>
      ) : (
        <section className="searchResultList" aria-label="Agent 投资研究社交网络搜索结果">
          {response.items.map((item) => (
            <SearchResultCard item={item} key={item.content_id} />
          ))}
        </section>
      )}

      {response.page.has_more && onNextPage && (
        <nav aria-label="搜索结果向前分页" className="feedPagination">
          <button
            className="smallGhostButton"
            disabled={pending}
            onClick={onNextPage}
            type="button"
          >
            下一页搜索结果 →
          </button>
        </nav>
      )}
    </>
  );
}
