import { createHash } from "node:crypto";

import * as oidc from "openid-client";

import { normalizeAdminReturnTo, type EnabledAdminWebConfig } from "./admin-web-config";
import type { AdminLoginTransaction } from "./admin-session-store";

const OIDC_RANDOM_VALUE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const ACCESS_TOKEN_PATTERN =
  /^[A-Za-z0-9_-]{1,8192}\.[A-Za-z0-9_-]{1,8192}\.[A-Za-z0-9_-]{1,8192}$/;
const MAX_CALLBACK_URL_LENGTH = 8_192;
const MAX_ACCESS_TOKEN_LIFETIME_SECONDS = 86_400;

export type AdminOidcFailure = "authentication_failed" | "provider_unavailable";

export class AdminOidcError extends Error {
  readonly code: AdminOidcFailure;

  constructor(code: AdminOidcFailure) {
    super(
      code === "authentication_failed"
        ? "Admin authentication failed."
        : "Admin authentication is temporarily unavailable.",
    );
    this.name = "AdminOidcError";
    this.code = code;
  }
}

export interface AdminOidcTokenResult {
  accessToken: string;
  expiresInSeconds: number | undefined;
  tokenType: string | undefined;
}

export interface AdminOidcAdapter {
  authorizationCodeGrant(
    configuration: unknown,
    callbackUrl: URL,
    checks: {
      expectedNonce: string;
      expectedState: string;
      pkceCodeVerifier: string;
    },
    tokenEndpointParameters: Record<string, string>,
  ): Promise<AdminOidcTokenResult>;
  buildAuthorizationUrl(configuration: unknown, parameters: Record<string, string>): URL;
  calculatePkceCodeChallenge(codeVerifier: string): Promise<string>;
  discover(config: EnabledAdminWebConfig): Promise<unknown>;
  randomNonce(): string;
  randomPkceCodeVerifier(): string;
  randomState(): string;
}

export interface AdminOidcService {
  createAuthorizationRequest(returnTo?: string | null): Promise<{
    authorizationUrl: URL;
    transaction: AdminLoginTransaction;
  }>;
  exchangeAuthorizationCode(
    callbackUrl: URL,
    transaction: AdminLoginTransaction,
  ): Promise<{ accessToken: string; tokenExpiresAt: Date }>;
}

export interface AdminOidcDependencies {
  adapter?: AdminOidcAdapter | undefined;
  now?: (() => Date) | undefined;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function validateDiscoveredProvider(configuration: oidc.Configuration): void {
  const metadata = configuration.serverMetadata();
  if (
    typeof metadata.authorization_endpoint !== "string" ||
    typeof metadata.token_endpoint !== "string" ||
    !metadata.response_types_supported?.includes("code") ||
    !metadata.code_challenge_methods_supported?.includes("S256") ||
    !metadata.token_endpoint_auth_methods_supported?.includes("client_secret_basic")
  ) {
    throw new AdminOidcError("provider_unavailable");
  }
}

const defaultAdapterImplementation: AdminOidcAdapter = {
  authorizationCodeGrant: async (
    configuration,
    callbackUrl,
    checks,
    tokenEndpointParameters,
  ) => {
    if (!(configuration instanceof oidc.Configuration)) {
      throw new AdminOidcError("provider_unavailable");
    }
    const tokens = await oidc.authorizationCodeGrant(
      configuration,
      callbackUrl,
      checks,
      tokenEndpointParameters,
    );
    return {
      accessToken: tokens.access_token,
      expiresInSeconds: tokens.expiresIn(),
      tokenType: tokens.token_type,
    };
  },
  buildAuthorizationUrl: (configuration, parameters) => {
    if (!(configuration instanceof oidc.Configuration)) {
      throw new AdminOidcError("provider_unavailable");
    }
    return oidc.buildAuthorizationUrl(configuration, parameters);
  },
  calculatePkceCodeChallenge: oidc.calculatePKCECodeChallenge,
  discover: async (config) => {
    const insecureLoopback = new URL(config.oidc.issuer).protocol === "http:";
    const configuration = await oidc.discovery(
      new URL(config.oidc.issuer),
      config.oidc.clientId,
      {
        client_secret: config.oidc.clientSecret,
        redirect_uris: [config.callbackUrl],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_basic",
      },
      oidc.ClientSecretBasic(config.oidc.clientSecret),
      {
        algorithm: "oidc",
        ...(insecureLoopback ? { execute: [oidc.allowInsecureRequests] } : {}),
        timeout: 5,
      },
    );
    validateDiscoveredProvider(configuration);
    return configuration;
  },
  randomNonce: oidc.randomNonce,
  randomPkceCodeVerifier: oidc.randomPKCECodeVerifier,
  randomState: oidc.randomState,
};
const defaultAdapter: AdminOidcAdapter = Object.freeze(defaultAdapterImplementation);

function validTransaction(value: AdminLoginTransaction): boolean {
  return (
    OIDC_RANDOM_VALUE_PATTERN.test(value.codeVerifier) &&
    OIDC_RANDOM_VALUE_PATTERN.test(value.nonce) &&
    OIDC_RANDOM_VALUE_PATTERN.test(value.state) &&
    normalizeAdminReturnTo(value.returnTo) === value.returnTo
  );
}

function safeAuthorizationUrl(
  url: URL,
  config: EnabledAdminWebConfig,
  expectedParameters: Readonly<Record<string, string>>,
): boolean {
  const httpLoopback =
    config.environment !== "production" &&
    url.protocol === "http:" &&
    isLoopback(url.hostname);
  const parameterNames = [...url.searchParams.keys()].map((name) => name.toLowerCase());
  return (
    url.href.length <= MAX_CALLBACK_URL_LENGTH &&
    (url.protocol === "https:" || httpLoopback) &&
    url.username === "" &&
    url.password === "" &&
    url.hash === "" &&
    !parameterNames.includes("client_secret") &&
    !parameterNames.includes("code_verifier") &&
    Object.entries(expectedParameters).every(
      ([name, value]) =>
        url.searchParams.getAll(name).length === 1 &&
        url.searchParams.get(name) === value,
    )
  );
}

function validCallbackUrl(
  callbackUrl: URL,
  transaction: AdminLoginTransaction,
  config: EnabledAdminWebConfig,
): boolean {
  if (
    callbackUrl.href.length > MAX_CALLBACK_URL_LENGTH ||
    callbackUrl.username !== "" ||
    callbackUrl.password !== "" ||
    callbackUrl.hash !== "" ||
    callbackUrl.origin !== config.publicOrigin ||
    callbackUrl.pathname !== "/admin/auth/callback" ||
    callbackUrl.searchParams.getAll("state").length !== 1 ||
    callbackUrl.searchParams.get("state") !== transaction.state
  ) {
    return false;
  }
  for (const credentialName of [
    "access_token",
    "api_key",
    "id_token",
    "refresh_token",
    "token",
  ]) {
    if (callbackUrl.searchParams.has(credentialName)) return false;
  }
  const codeCount = callbackUrl.searchParams.getAll("code").length;
  const errorCount = callbackUrl.searchParams.getAll("error").length;
  return (codeCount === 1 && errorCount === 0) || (codeCount === 0 && errorCount === 1);
}

function oidcFingerprint(config: EnabledAdminWebConfig): string {
  return createHash("sha256")
    .update(
      [
        config.callbackUrl,
        config.oidc.clientId,
        config.oidc.clientSecret,
        config.oidc.issuer,
        config.oidc.resource ?? "",
        ...config.oidc.scopes,
      ].join("\n"),
    )
    .digest("base64url");
}

export function createAdminOidcService(
  config: EnabledAdminWebConfig,
  dependencies: AdminOidcDependencies = {},
): AdminOidcService {
  const adapter = dependencies.adapter ?? defaultAdapter;
  const now = dependencies.now ?? (() => new Date());
  let discoveryPromise: Promise<unknown> | undefined;

  async function configuration(): Promise<unknown> {
    discoveryPromise ??= adapter.discover(config).catch(() => {
      discoveryPromise = undefined;
      throw new AdminOidcError("provider_unavailable");
    });
    return discoveryPromise;
  }

  const service: AdminOidcService = {
    createAuthorizationRequest: async (returnTo) => {
      try {
        const codeVerifier = adapter.randomPkceCodeVerifier();
        const state = adapter.randomState();
        const nonce = adapter.randomNonce();
        if (
          !OIDC_RANDOM_VALUE_PATTERN.test(codeVerifier) ||
          !OIDC_RANDOM_VALUE_PATTERN.test(state) ||
          !OIDC_RANDOM_VALUE_PATTERN.test(nonce)
        ) {
          throw new AdminOidcError("provider_unavailable");
        }
        const codeChallenge = await adapter.calculatePkceCodeChallenge(codeVerifier);
        if (!OIDC_RANDOM_VALUE_PATTERN.test(codeChallenge)) {
          throw new AdminOidcError("provider_unavailable");
        }
        const provider = await configuration();
        const parameters: Record<string, string> = {
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          nonce,
          redirect_uri: config.callbackUrl,
          response_type: "code",
          scope: config.oidc.scopes.join(" "),
          state,
          ...(config.oidc.resource ? { resource: config.oidc.resource } : {}),
        };
        const authorizationUrl = adapter.buildAuthorizationUrl(provider, parameters);
        if (!safeAuthorizationUrl(authorizationUrl, config, parameters)) {
          throw new AdminOidcError("provider_unavailable");
        }
        return {
          authorizationUrl,
          transaction: Object.freeze({
            codeVerifier,
            nonce,
            returnTo: normalizeAdminReturnTo(returnTo),
            state,
          }),
        };
      } catch (error) {
        if (error instanceof AdminOidcError) throw error;
        throw new AdminOidcError("provider_unavailable");
      }
    },
    exchangeAuthorizationCode: async (callbackUrl, transaction) => {
      if (
        !validTransaction(transaction) ||
        !validCallbackUrl(callbackUrl, transaction, config)
      ) {
        throw new AdminOidcError("authentication_failed");
      }
      try {
        const provider = await configuration();
        const result = await adapter.authorizationCodeGrant(
          provider,
          callbackUrl,
          {
            expectedNonce: transaction.nonce,
            expectedState: transaction.state,
            pkceCodeVerifier: transaction.codeVerifier,
          },
          config.oidc.resource ? { resource: config.oidc.resource } : {},
        );
        if (
          !ACCESS_TOKEN_PATTERN.test(result.accessToken) ||
          !Number.isInteger(result.expiresInSeconds) ||
          result.expiresInSeconds === undefined ||
          result.expiresInSeconds < 1 ||
          result.expiresInSeconds > MAX_ACCESS_TOKEN_LIFETIME_SECONDS ||
          result.tokenType?.toLowerCase() !== "bearer"
        ) {
          throw new AdminOidcError("authentication_failed");
        }
        return Object.freeze({
          accessToken: result.accessToken,
          tokenExpiresAt: new Date(now().valueOf() + result.expiresInSeconds * 1_000),
        });
      } catch {
        throw new AdminOidcError("authentication_failed");
      }
    },
  };
  return Object.freeze(service);
}

let cachedDefaultService: { fingerprint: string; service: AdminOidcService } | undefined;

export function getAdminOidcService(config: EnabledAdminWebConfig): AdminOidcService {
  const fingerprint = oidcFingerprint(config);
  if (cachedDefaultService?.fingerprint === fingerprint) {
    return cachedDefaultService.service;
  }
  const service = createAdminOidcService(config);
  cachedDefaultService = { fingerprint, service };
  return service;
}
