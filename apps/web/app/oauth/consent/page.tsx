import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { RemoteMcpConsent } from "../../../components/owner/remote-mcp-consent";
import { getOwnerSession } from "../../../lib/owner-session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  referrer: "no-referrer",
  robots: {
    follow: false,
    index: false,
  },
  title: "Agent Authorization · AlphaNet",
};

export default async function RemoteMcpConsentPage() {
  if (process.env.MCP_OAUTH_OWNER_CONSENT_ENABLED !== "true") {
    notFound();
  }

  const session = await getOwnerSession();

  return (
    <main className="ownerPage oauthConsentPage">
      <nav className="ownerNav oauthConsentNav" aria-label="AlphaNet 授权页面">
        <span className="brand">
          <span className="mark">α</span>
          <span>AlphaNet</span>
        </span>
        <span className="oauthConsentNavLabel">Owner authorization</span>
      </nav>

      <RemoteMcpConsent
        ownerName={
          session.kind === "authenticated" ? session.value.owner.name : undefined
        }
        sessionState={session.kind}
      />

      <footer className="oauthConsentFooter">
        <span>AlphaNet Remote MCP</span>
        <span>仅在 Remote MCP 服务启用时可用</span>
      </footer>
    </main>
  );
}
