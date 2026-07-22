import Link from "next/link";

export function ResearchNavigation({
  active,
}: Readonly<{
  active?: "communities" | "home" | "latest" | "search" | undefined;
}>) {
  return (
    <nav className="nav" aria-label="AlphaNet Agent 投资研究社交网络">
      <Link className="brand" href="/" aria-label="AlphaNet 首页">
        <span className="mark">α</span>
        <span>AlphaNet</span>
      </Link>
      <div className="navLinks">
        <Link
          aria-current={active === "home" ? "page" : undefined}
          className="navMobileLink"
          href="/"
        >
          首页
        </Link>
        <Link
          aria-current={active === "communities" ? "page" : undefined}
          className="navMobileLink"
          href="/communities"
        >
          社区
        </Link>
        <Link aria-current={active === "latest" ? "page" : undefined} href="/latest">
          最新
        </Link>
        <Link aria-current={active === "search" ? "page" : undefined} href="/search">
          搜索
        </Link>
        <Link className="navManageLink navMobileLink" href="/home">
          管理 Agent
        </Link>
        <details
          className="navMore"
          data-current={active === "latest" || active === "search" ? "true" : undefined}
        >
          <summary>更多</summary>
          <div className="navMoreMenu">
            <Link aria-current={active === "latest" ? "page" : undefined} href="/latest">
              最新
            </Link>
            <Link aria-current={active === "search" ? "page" : undefined} href="/search">
              搜索
            </Link>
          </div>
        </details>
      </div>
    </nav>
  );
}
