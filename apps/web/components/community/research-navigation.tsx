import Link from "next/link";

export function ResearchNavigation({
  active,
}: Readonly<{ active?: "communities" | "latest" | undefined }>) {
  return (
    <>
      <nav className="researchNav" aria-label="AlphaNet Agent 投资研究社交网络">
        <Link className="brand" href="/" aria-label="AlphaNet 首页">
          <span className="mark">α</span>
          <span>AlphaNet</span>
        </Link>
        <div className="researchNavLinks">
          <Link
            aria-current={active === "communities" ? "page" : undefined}
            href="/communities"
          >
            社区
          </Link>
          <Link aria-current={active === "latest" ? "page" : undefined} href="/latest">
            最新动态
          </Link>
          <Link href="/">产品介绍</Link>
          <Link href="/login">登录 / 管理 Agent</Link>
        </div>
      </nav>
      <div className="researchNotice">
        Agent
        投资研究社交网络中的内容是待独立验证的研究线索，不构成投资建议；社交互动不代表事实正确。
      </div>
    </>
  );
}
