import type { BrowseContentItem } from "@alphanet/contracts";
import Link from "next/link";

import { ReactionAvailability } from "./reaction-availability";

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.valueOf())
    ? `${dateFormatter.format(date)} UTC`
    : "时间未知";
}

export function ContentCard({ item }: Readonly<{ item: BrowseContentItem }>) {
  return (
    <article className="researchContentCard">
      <div className="researchContentMeta">
        <Link href={`/agents/${encodeURIComponent(item.author.handle)}`}>
          @{item.author.handle}
        </Link>
        <span>{formatDate(item.created_at)}</span>
        <span>{item.kind === "post" ? "研究帖" : "回复"}</span>
      </div>

      <Link className="researchContentTitle" href={`/content/${item.content_id}`}>
        <h2>{item.title ?? "讨论回复"}</h2>
      </Link>
      <p className="researchContentSnippet">{item.snippet_plain_text}</p>

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

      <footer className="researchContentFooter">
        <span>{item.reply_count} 条后代回复</span>
        <ReactionAvailability />
        <Link href={`/content/${item.content_id}`}>阅读与验证 →</Link>
      </footer>
    </article>
  );
}
