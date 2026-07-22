import { describe, expect, it, vi } from "vitest";

import { createAlphaNetRemoteMcpOAuthPostLogin } from "./remote-mcp-oauth-post-login.js";

const ownerSessionId = "10000000-0000-4000-8000-000000000001";
const grantId = "20000000-0000-4000-8000-000000000002";

function context() {
  return {
    headers: new Headers(),
    scopes: ["content:read"],
    session: { id: ownerSessionId },
    user: { id: "auth-user" },
  };
}

describe("Remote MCP OAuth post-login adapter", () => {
  it("keeps every initial authorization behind explicit Agent selection", async () => {
    const postLogin = createAlphaNetRemoteMcpOAuthPostLogin({
      consentPage: "https://app.alphanet.test/oauth/consent",
      consentService: {
        resolveContinuationHandle: vi.fn(),
      },
    });

    await expect(postLogin.shouldRedirect(context() as never)).resolves.toBe(true);
    expect(postLogin.page).toBe("https://app.alphanet.test/oauth/consent");
  });

  it.each(["inspect", "claim"] as const)(
    "binds the %s phase to the current Owner session and opaque continuation",
    async (phase) => {
      const resolveContinuationHandle = vi.fn(() =>
        Promise.resolve({
          authorizationRequestId: "30000000-0000-4000-8000-000000000003",
          credentialPolicyCeiling: {
            defaultsVersion: "defaults-v1",
            schemaVersion: 1,
            tier: "assisted" as const,
          },
          grantId,
        }),
      );
      const postLogin = createAlphaNetRemoteMcpOAuthPostLogin({
        consentPage: "http://127.0.0.1:3101/oauth/consent",
        consentService: { resolveContinuationHandle },
      });

      await expect(
        postLogin.resolveGrantId(context() as never, phase, "aln_oauth_continuation_v1"),
      ).resolves.toBe(grantId);
      expect(resolveContinuationHandle).toHaveBeenCalledExactlyOnceWith({
        continuationHandle: "aln_oauth_continuation_v1",
        ownerSessionId,
        phase,
      });
    },
  );

  it("fails closed when the Provider request has no validated continuation", async () => {
    const resolveContinuationHandle = vi.fn();
    const postLogin = createAlphaNetRemoteMcpOAuthPostLogin({
      consentPage: "https://app.alphanet.test/oauth/consent",
      consentService: { resolveContinuationHandle },
    });

    await expect(
      postLogin.resolveGrantId(context() as never, "inspect", undefined),
    ).rejects.toThrow("continuation is required");
    expect(resolveContinuationHandle).not.toHaveBeenCalled();
  });

  it.each([
    "/oauth/consent",
    "https://app.alphanet.test/other",
    "https://app.alphanet.test/oauth/consent?flow=1",
    "http://app.alphanet.test/oauth/consent",
  ])("rejects a non-canonical consent page: %s", (consentPage) => {
    expect(() =>
      createAlphaNetRemoteMcpOAuthPostLogin({
        consentPage,
        consentService: { resolveContinuationHandle: vi.fn() },
      }),
    ).toThrow("consent page is invalid");
  });
});
