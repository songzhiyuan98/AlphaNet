#!/usr/bin/env node

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

import { exportJWK, generateKeyPair, SignJWT } from "jose";

const host = process.env.E2E_ADMIN_OIDC_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.E2E_ADMIN_OIDC_PORT ?? 55_560);
const issuer =
  process.env.E2E_ADMIN_OIDC_ISSUER?.trim() || `http://${host}:${port}/workforce`;
const clientId = process.env.E2E_ADMIN_OIDC_CLIENT_ID?.trim() || "alphanet-admin-web-e2e";
const clientSecret =
  process.env.E2E_ADMIN_OIDC_CLIENT_SECRET?.trim() ||
  "admin-web-e2e-client-secret-32-bytes-minimum";
const redirectUri =
  process.env.E2E_ADMIN_OIDC_REDIRECT_URI?.trim() ||
  "http://127.0.0.1:3300/admin/auth/callback";
const audience =
  process.env.E2E_ADMIN_OIDC_AUDIENCE?.trim() || "urn:alphanet:admin-api:e2e";
const subject =
  process.env.E2E_ADMIN_OIDC_SUBJECT?.trim() || "alphanet-e2e-content-moderator";
const keyId = "alphanet-admin-e2e-rs256-v1";
const authorizationLifetimeMs = 5 * 60_000;
const codeLifetimeMs = 60_000;

function fail(message) {
  process.stderr.write(`Admin OIDC E2E provider: ${message}\n`);
  process.exit(2);
}

function isLoopback(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

let issuerUrl;
try {
  issuerUrl = new URL(issuer);
} catch {
  fail("E2E_ADMIN_OIDC_ISSUER must be an absolute URL.");
}
if (
  issuerUrl.protocol !== "http:" ||
  !isLoopback(issuerUrl.hostname) ||
  issuerUrl.search ||
  issuerUrl.hash
) {
  fail("the fake provider is restricted to a loopback HTTP issuer.");
}
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  fail("E2E_ADMIN_OIDC_PORT is invalid.");
}
if (clientId.length < 1 || clientId.length > 200 || clientSecret.length < 32) {
  fail("the E2E OIDC client credentials are invalid.");
}
if (redirectUri !== new URL(redirectUri).toString()) {
  fail("E2E_ADMIN_OIDC_REDIRECT_URI must be canonical.");
}

const authorizationEndpoint = `${issuerUrl.origin}${issuerUrl.pathname.replace(/\/$/u, "")}/authorize`;
const tokenEndpoint = `${issuerUrl.origin}${issuerUrl.pathname.replace(/\/$/u, "")}/token`;
const jwksUri = `${issuerUrl.origin}${issuerUrl.pathname.replace(/\/$/u, "")}/jwks.json`;
const discoveryPath = `${issuerUrl.pathname.replace(/\/$/u, "")}/.well-known/openid-configuration`;

const { privateKey, publicKey } = await generateKeyPair("RS256", {
  extractable: true,
  modulusLength: 2048,
});
const publicJwk = {
  ...(await exportJWK(publicKey)),
  alg: "RS256",
  kid: keyId,
  use: "sig",
};

const pendingAuthorizations = new Map();
const authorizationCodes = new Map();

function cleanupExpired(now = Date.now()) {
  for (const [id, value] of pendingAuthorizations) {
    if (value.expiresAt <= now) pendingAuthorizations.delete(id);
  }
  for (const [code, value] of authorizationCodes) {
    if (value.expiresAt <= now) authorizationCodes.delete(code);
  }
}

function sendJson(response, status, value, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": String(body.byteLength),
    "content-type": "application/json; charset=utf-8",
    pragma: "no-cache",
    ...extraHeaders,
  });
  response.end(body);
}

function sendHtml(response, status, html) {
  const body = Buffer.from(html);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": String(body.byteLength),
    "content-security-policy": `default-src 'none'; form-action 'self' ${
      new URL(redirectUri).origin
    }; frame-ancestors 'none'; style-src 'unsafe-inline'`,
    "content-type": "text/html; charset=utf-8",
    pragma: "no-cache",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  response.end(body);
}

function oauthError(response, status, error, description) {
  sendJson(response, status, { error, error_description: description });
}

async function readForm(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.byteLength;
    if (total > 16_384) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function one(parameters, name) {
  const values = parameters.getAll(name);
  return values.length === 1 ? values[0] : null;
}

function validBase64Url(value, minimum = 32, maximum = 128) {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum &&
    /^[A-Za-z0-9_-]+$/u.test(value)
  );
}

function secureEqual(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function parseClientAuthentication(request) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Basic ")) {
    return null;
  }
  let decoded;
  try {
    decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
  } catch {
    return null;
  }
  const separator = decoded.indexOf(":");
  if (separator < 1) return null;
  try {
    return {
      id: decodeURIComponent(decoded.slice(0, separator)),
      secret: decodeURIComponent(decoded.slice(separator + 1)),
    };
  } catch {
    return null;
  }
}

function validateAuthorizationRequest(url) {
  const parameters = url.searchParams;
  const requestedClientId = one(parameters, "client_id");
  const requestedRedirectUri = one(parameters, "redirect_uri");
  const responseType = one(parameters, "response_type");
  const scope = one(parameters, "scope");
  const state = one(parameters, "state");
  const nonce = one(parameters, "nonce");
  const codeChallenge = one(parameters, "code_challenge");
  const codeChallengeMethod = one(parameters, "code_challenge_method");
  const resource = one(parameters, "resource");
  if (
    requestedClientId !== clientId ||
    requestedRedirectUri !== redirectUri ||
    responseType !== "code" ||
    !scope?.split(" ").includes("openid") ||
    !validBase64Url(state) ||
    !validBase64Url(nonce) ||
    !validBase64Url(codeChallenge, 43, 128) ||
    codeChallengeMethod !== "S256" ||
    (resource !== null && resource !== audience)
  ) {
    return null;
  }
  return {
    clientId: requestedClientId,
    codeChallenge,
    nonce,
    redirectUri: requestedRedirectUri,
    resource: resource ?? audience,
    scope,
    state,
  };
}

function renderMfaPage(requestId) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>AlphaNet E2E Workforce MFA</title>
    <style>
      :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #050805; color: #f4f6ef; }
      main { width: min(30rem, calc(100vw - 3rem)); border: 1px solid #31451f; border-radius: 1.25rem; padding: 2rem; background: #0b100b; }
      p { color: #aeb7aa; line-height: 1.55; }
      button { width: 100%; margin-top: 1rem; border: 0; border-radius: .8rem; padding: .9rem 1rem; background: #a8f130; color: #10170a; font: inherit; font-weight: 750; cursor: pointer; }
    </style>
  </head>
  <body>
    <main>
      <small>Fake Workforce IdP · browser E2E only</small>
      <h1>Complete workforce MFA</h1>
      <p>This disposable provider proves that AlphaNet's Admin flow requires an OIDC authorization code, PKCE, and MFA evidence.</p>
      <form action="${authorizationEndpoint}" method="post">
        <input type="hidden" name="request_id" value="${requestId}">
        <button type="submit">Approve with MFA</button>
      </form>
    </main>
  </body>
</html>`;
}

function oidcHash(value) {
  const digest = createHash("sha256").update(value).digest();
  return digest.subarray(0, digest.byteLength / 2).toString("base64url");
}

async function signAccessToken(nowSeconds) {
  return new SignJWT({
    acr: "urn:alphanet:e2e:mfa",
    amr: ["pwd", "mfa"],
    azp: clientId,
  })
    .setProtectedHeader({ alg: "RS256", kid: keyId, typ: "at+jwt" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + 600)
    .setJti(randomUUID())
    .sign(privateKey);
}

async function signIdToken(nowSeconds, authorization, code, accessToken) {
  return new SignJWT({
    acr: "urn:alphanet:e2e:mfa",
    amr: ["pwd", "mfa"],
    at_hash: oidcHash(accessToken),
    auth_time: nowSeconds,
    c_hash: oidcHash(code),
    nonce: authorization.nonce,
  })
    .setProtectedHeader({ alg: "RS256", kid: keyId, typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(clientId)
    .setSubject(subject)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + 600)
    .sign(privateKey);
}

const server = createServer(async (request, response) => {
  cleanupExpired();
  let url;
  try {
    url = new URL(request.url ?? "/", issuerUrl.origin);
  } catch {
    return oauthError(response, 400, "invalid_request", "The request URL is invalid.");
  }

  if (request.method === "GET" && url.pathname === "/health/ready") {
    return sendJson(response, 200, { service: "admin-oidc-e2e", status: "ok" });
  }
  if (
    request.method === "GET" &&
    (url.pathname === discoveryPath ||
      url.pathname === `/.well-known/openid-configuration${issuerUrl.pathname}`)
  ) {
    return sendJson(response, 200, {
      authorization_endpoint: authorizationEndpoint,
      claims_supported: ["sub", "iss", "aud", "exp", "iat", "nonce", "acr", "amr"],
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code"],
      id_token_signing_alg_values_supported: ["RS256"],
      issuer,
      jwks_uri: jwksUri,
      response_types_supported: ["code"],
      scopes_supported: ["openid", "profile", "email"],
      subject_types_supported: ["public"],
      token_endpoint: tokenEndpoint,
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
    });
  }
  if (request.method === "GET" && url.pathname === new URL(jwksUri).pathname) {
    return sendJson(response, 200, { keys: [publicJwk] });
  }
  if (url.pathname === new URL(authorizationEndpoint).pathname) {
    if (request.method === "GET") {
      const authorization = validateAuthorizationRequest(url);
      if (!authorization) {
        return oauthError(
          response,
          400,
          "invalid_request",
          "The authorization request does not match the E2E client.",
        );
      }
      const requestId = randomUUID();
      pendingAuthorizations.set(requestId, {
        ...authorization,
        expiresAt: Date.now() + authorizationLifetimeMs,
      });
      return sendHtml(response, 200, renderMfaPage(requestId));
    }
    if (request.method === "POST") {
      let form;
      try {
        form = await readForm(request);
      } catch {
        return oauthError(
          response,
          413,
          "invalid_request",
          "The MFA response is too large.",
        );
      }
      const requestId = one(form, "request_id");
      const authorization = requestId ? pendingAuthorizations.get(requestId) : null;
      if (!requestId || !authorization) {
        return oauthError(response, 400, "invalid_request", "The MFA request expired.");
      }
      pendingAuthorizations.delete(requestId);
      const code = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
      authorizationCodes.set(code, {
        ...authorization,
        expiresAt: Date.now() + codeLifetimeMs,
      });
      process.stdout.write("Admin OIDC E2E MFA approved; issuing authorization code.\n");
      const callback = new URL(authorization.redirectUri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", authorization.state);
      response.writeHead(303, {
        "cache-control": "no-store",
        location: callback.toString(),
        pragma: "no-cache",
        "referrer-policy": "no-referrer",
      });
      return response.end();
    }
  }
  if (request.method === "POST" && url.pathname === new URL(tokenEndpoint).pathname) {
    process.stdout.write("Admin OIDC E2E token exchange received.\n");
    const client = parseClientAuthentication(request);
    if (
      !client ||
      !secureEqual(client.id, clientId) ||
      !secureEqual(client.secret, clientSecret)
    ) {
      return oauthError(response, 401, "invalid_client", "Client authentication failed.");
    }
    let form;
    try {
      form = await readForm(request);
    } catch {
      return oauthError(
        response,
        413,
        "invalid_request",
        "The token request is too large.",
      );
    }
    const code = one(form, "code");
    const authorization = code ? authorizationCodes.get(code) : null;
    const verifier = one(form, "code_verifier");
    const expectedChallenge = verifier
      ? createHash("sha256").update(verifier).digest("base64url")
      : null;
    if (
      !code ||
      !authorization ||
      one(form, "grant_type") !== "authorization_code" ||
      one(form, "redirect_uri") !== authorization.redirectUri ||
      !validBase64Url(verifier, 43, 128) ||
      expectedChallenge !== authorization.codeChallenge ||
      (one(form, "resource") !== null && one(form, "resource") !== authorization.resource)
    ) {
      return oauthError(
        response,
        400,
        "invalid_grant",
        "The authorization code is invalid.",
      );
    }
    authorizationCodes.delete(code);
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const accessToken = await signAccessToken(nowSeconds);
    const idToken = await signIdToken(nowSeconds, authorization, code, accessToken);
    return sendJson(response, 200, {
      access_token: accessToken,
      expires_in: 600,
      id_token: idToken,
      scope: authorization.scope,
      token_type: "Bearer",
    });
  }

  return sendJson(response, 404, { error: "not_found" });
});

server.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});

const shutdown = () => {
  server.close(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

server.listen(port, host, () => {
  process.stdout.write(`Admin OIDC E2E provider listening at ${issuer}\n`);
});
