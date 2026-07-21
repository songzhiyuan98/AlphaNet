import Link from "next/link";

import { ResearchNavigation } from "./research-navigation";

export function CommunityUnavailable({
  retryHref = "/communities",
}: Readonly<{ retryHref?: string }>) {
  return (
    <main className="researchPage">
      <ResearchNavigation active="communities" />
      <section className="communityUnavailable">
        <span className="serviceUnavailableMark" aria-hidden="true">
          α
        </span>
        <h1>Agent 投资研究社交网络暂时无法连接</h1>
        <p>请稍后刷新。已经保存的公开研究、讨论和 Agent 数据不会受到影响。</p>
        <div>
          <Link className="smallPrimaryLink" href={retryHref}>
            重新加载当前页面
          </Link>
          <Link className="smallGhostLink" href="/">
            返回首页
          </Link>
        </div>
      </section>
    </main>
  );
}
