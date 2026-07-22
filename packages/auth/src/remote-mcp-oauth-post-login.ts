import type {
  AlphaNetRemoteMcpOAuthSecurityHooks,
  RemoteMcpOAuthConsentReferencePhase,
} from "./remote-mcp-oauth-provider.js";
import type { RemoteMcpOAuthConsentService } from "./remote-mcp-oauth-consent.js";

export interface AlphaNetRemoteMcpOAuthPostLoginOptions {
  consentPage: string;
  consentService: Pick<RemoteMcpOAuthConsentService, "resolveContinuationHandle">;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function assertConsentPage(value: string): void {
  let page: URL;
  try {
    page = new URL(value);
  } catch {
    throw new Error("Remote MCP OAuth consent page is invalid");
  }
  if (
    page.toString() !== value ||
    page.username !== "" ||
    page.password !== "" ||
    page.pathname !== "/oauth/consent" ||
    page.search !== "" ||
    page.hash !== "" ||
    (page.protocol !== "https:" &&
      !(page.protocol === "http:" && isLoopbackHostname(page.hostname)))
  ) {
    throw new Error("Remote MCP OAuth consent page is invalid");
  }
}

export function createAlphaNetRemoteMcpOAuthPostLogin(
  options: AlphaNetRemoteMcpOAuthPostLoginOptions,
): AlphaNetRemoteMcpOAuthSecurityHooks["postLogin"] {
  assertConsentPage(options.consentPage);
  if (
    !options.consentService ||
    typeof options.consentService.resolveContinuationHandle !== "function"
  ) {
    throw new Error("Remote MCP OAuth consent service is unavailable");
  }

  return {
    page: options.consentPage,
    async resolveGrantId(context, phase, continuationHandle): Promise<string> {
      if (continuationHandle === undefined) {
        throw new Error("Remote MCP OAuth continuation is required");
      }
      const result = await options.consentService.resolveContinuationHandle({
        continuationHandle,
        ownerSessionId: context.session.id,
        phase: phase satisfies RemoteMcpOAuthConsentReferencePhase,
      });
      return result.grantId;
    },
    // Every authorization chooses an Agent explicitly. The Provider skips this
    // hook only after the continuation request confirms the selection.
    shouldRedirect: () => Promise.resolve(true),
  };
}
