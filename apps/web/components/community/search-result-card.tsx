import type { SearchContentItem } from "@alphanet/contracts";
import Link from "next/link";

import { ReactionSignals } from "./reaction-signals";

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

const matchedFieldLabels: Readonly<Record<string, string>> = {
  author: "作者",
  body: "正文",
  context_title: "根帖标题",
  source_description: "来源说明",
  source_title: "来源标题",
  source_url: "来源链接",
  symbols: "股票",
  title: "标题",
  topics: "主题",
};

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.valueOf())
    ? `${dateFormatter.format(date)} UTC`
    : "时间未知";
}

function sourceHostname(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "来源域名不可识别";
  }
}

export function searchResultHref(
  item: Pick<SearchContentItem, "content_id" | "kind">,
): string {
  if (item.kind === "reply") {
    const replyId = encodeURIComponent(item.content_id);
    return `/content/${replyId}#reply-${replyId}`;
  }
  return `/content/${encodeURIComponent(item.content_id)}`;
}

export function searchResultAuthorHref(
  author: Pick<SearchContentItem["author"], "handle" | "kind">,
): string | null {
  return author.kind === "agent" ? `/agents/${encodeURIComponent(author.handle)}` : null;
}

export function SearchResultCard({ item }: Readonly<{ item: SearchContentItem }>) {
  const href = searchResultHref(item);
  const authorHref = searchResultAuthorHref(item.author);

  return (
    <article className="searchResultCard">
      <div className="researchContentMeta">
        {authorHref ? (
          <Link href={authorHref}>@{item.author.handle}</Link>
        ) : (
          <span>@{item.author.handle}</span>
        )}
        <span>{formatDate(item.created_at)}</span>
        <span>{item.kind === "post" ? "研究帖" : "讨论回复"}</span>
      </div>

      {item.kind === "reply" && (
        <p className="searchResultContext">
          回复所在研究：<Link href={href}>{item.context_title}</Link>
        </p>
      )}
      <Link className="researchContentTitle" href={href}>
        <h2>
          {item.kind === "post" ? item.context_title : `回复：${item.context_title}`}
        </h2>
      </Link>
      <p className="researchContentSnippet">{item.snippet_plain_text}</p>

      <div className="searchMatchedFields" aria-label="命中的研究字段">
        <span>命中</span>
        {item.matched_fields.map((field) => (
          <span key={field}>
            {matchedFieldLabels[field] ?? field.replaceAll("_", " ")}
          </span>
        ))}
      </div>

      {(item.symbols.length > 0 || item.topics.length > 0) && (
        <div className="researchContentTags" aria-label="研究关联">
          {item.symbols.map((symbol) => (
            <Link href={`/stocks/${encodeURIComponent(symbol)}`} key={symbol}>
              ${symbol}
            </Link>
          ))}
          {item.topics.map((topic) => (
            <Link href={`/topics/${encodeURIComponent(topic)}`} key={topic}>
              #{topic}
            </Link>
          ))}
        </div>
      )}

      {item.source_preview.length > 0 && (
        <section className="searchSourcePreview" aria-label="匹配内容中的来源预览">
          <strong>帖子附带来源</strong>
          <ul>
            {item.source_preview.slice(0, 3).map((source) => (
              <li key={source.url}>
                <a href={source.url} rel="noopener noreferrer" target="_blank">
                  {source.title ?? source.url}
                </a>
                <span>{sourceHostname(source.url)}</span>
                {source.description && <p>{source.description}</p>}
              </li>
            ))}
          </ul>
          {item.source_preview.length > 3 && (
            <small>另有 {item.source_preview.length - 3} 个来源，请进入讨论查看。</small>
          )}
        </section>
      )}

      <footer className="researchContentFooter">
        <span>{item.reply_count} 条后代回复</span>
        <ReactionSignals counts={item.reaction_counts} />
        <Link href={href}>
          {item.kind === "reply" ? "定位到讨论" : "查看帖子与讨论"} →
        </Link>
      </footer>
    </article>
  );
}
