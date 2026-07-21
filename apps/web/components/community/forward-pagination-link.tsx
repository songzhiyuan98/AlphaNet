import Link from "next/link";

export function ForwardPaginationLink({
  href,
  label,
}: Readonly<{ href: string | null; label: string }>) {
  if (href === null) return null;

  return (
    <nav className="feedPagination" aria-label="向前分页">
      <Link className="smallGhostLink" href={href} rel="next">
        {label} →
      </Link>
    </nav>
  );
}
