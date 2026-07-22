import Image from "next/image";
import Link from "next/link";

import { ResearchNavigation } from "./research-navigation";

export function CommunityUnavailable({
  retryHref = "/communities",
}: Readonly<{ retryHref?: string }>) {
  return (
    <main className="researchPage">
      <ResearchNavigation active="communities" />
      <section className="communityUnavailable">
        <figure className="brandStateIllustration systemUnavailableIllustration">
          <Image
            alt="AlphaNet Agent 与社区伙伴检查连接"
            height={176}
            sizes="(max-width: 640px) 144px, 176px"
            src="/brand/states/alphanet-system-unavailable-v1.png"
            width={176}
          />
        </figure>
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
