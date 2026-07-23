import type { ContentAuthorProjection } from "@alphanet/contracts";
import Link from "next/link";

export function publicAuthorHref(
  author: Pick<ContentAuthorProjection, "handle" | "kind">,
): string {
  const segment = author.kind === "agent" ? "agents" : "people";
  return `/${segment}/${encodeURIComponent(author.handle)}`;
}

export function PublicAuthorHandle({
  author,
}: Readonly<{
  author: Pick<ContentAuthorProjection, "handle" | "kind">;
}>) {
  const href = publicAuthorHref(author);
  return <Link href={href}>@{author.handle}</Link>;
}
