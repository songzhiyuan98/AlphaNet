import { Buffer } from "node:buffer";

export const DEFAULT_ADMIN_RETURN_TO = "/admin/moderation";
export const ADMIN_LOGIN_COOKIE_NAMES = {
  local: "alphanet-admin-login-local",
  secure: "__Host-alphanet-admin-login",
} as const;
export const ADMIN_SESSION_COOKIE_NAMES = {
  local: "alphanet-admin-session-local",
  secure: "__Host-alphanet-admin-session",
} as const;

export interface DisabledAdminWebConfig {
  enabled: false;
}

export interface EnabledAdminWebConfig {
  awsRegion: string;
  callbackUrl: string;
  dynamodbEndpoint: string | null;
  enabled: true;
  environment: "development" | "production" | "test";
  loginCookieName:
    | (typeof ADMIN_LOGIN_COOKIE_NAMES)["local"]
    | (typeof ADMIN_LOGIN_COOKIE_NAMES)["secure"];
  loginTtlSeconds: number;
  oidc: {
    clientId: string;
    clientSecret: string;
    issuer: string;
    resource: string | null;
    scopes: readonly string[];
  };
  publicOrigin: string;
  secureCookies: boolean;
  sessionCookieName:
    | (typeof ADMIN_SESSION_COOKIE_NAMES)["local"]
    | (typeof ADMIN_SESSION_COOKIE_NAMES)["secure"];
  sessionEncryptionKey: Uint8Array;
  sessionStore: "dynamodb";
  sessionTable: string;
  sessionTtlSeconds: number;
}

export type AdminWebConfig = DisabledAdminWebConfig | EnabledAdminWebConfig;

export class AdminWebConfigurationError extends Error {
  readonly code = "invalid_admin_web_configuration";

  constructor(fields: readonly string[]) {
    super(`Invalid Admin Web configuration (${[...new Set(fields)].sort().join(", ")}).`);
    this.name = "AdminWebConfigurationError";
  }
}

const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const awsRegionPattern = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;
const tableNamePattern = /^[A-Za-z0-9_.-]{3,255}$/;
const scopePattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

function present(value: string | undefined): string | null {
  if (value === undefined || value.length === 0 || value.trim() !== value) return null;
  return value;
}

function isPrintableAscii(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined || code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function parseEnvironment(
  value: string | undefined,
): EnabledAdminWebConfig["environment"] | null {
  if (value === undefined) return "development";
  if (value === "production" || value === "test" || value === "development") {
    return value;
  }
  return null;
}

function parseUrl(
  raw: string | null,
  field: string,
  environment: EnabledAdminWebConfig["environment"],
  options: { originOnly?: boolean; productionHttps?: boolean } = {},
): { issue: string | null; url: URL | null } {
  if (raw === null) return { issue: field, url: null };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { issue: field, url: null };
  }
  const httpAllowed =
    environment !== "production" && url.protocol === "http:" && isLoopback(url.hostname);
  if (
    (url.protocol !== "https:" && !httpAllowed) ||
    (options.productionHttps === true &&
      environment === "production" &&
      url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    (options.originOnly === true &&
      (url.pathname !== "/" || url.search !== "" || raw !== url.origin))
  ) {
    return { issue: field, url: null };
  }
  return { issue: null, url };
}

function parseInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number | null {
  const value = raw === undefined ? fallback : Number(raw);
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : null;
}

function parseEncryptionKey(raw: string | null): Uint8Array | null {
  if (raw === null || !/^[A-Za-z0-9+/]{43}=$/.test(raw)) return null;
  const decoded = Buffer.from(raw, "base64");
  if (decoded.byteLength !== 32 || decoded.toString("base64") !== raw) return null;
  return Uint8Array.from(decoded);
}

function parseResourceUri(
  raw: string | null,
  environment: EnabledAdminWebConfig["environment"],
): string | null {
  if (
    raw === null ||
    raw.length > 512 ||
    !isPrintableAscii(raw) ||
    [...raw].some((character) => /\s/u.test(character))
  ) {
    return null;
  }
  let resource: URL;
  try {
    resource = new URL(raw);
  } catch {
    return null;
  }
  if (resource.hash !== "" || resource.username !== "" || resource.password !== "") {
    return null;
  }
  if (resource.protocol === "urn:") {
    return resource.search === "" && resource.pathname.length > 0 ? raw : null;
  }
  const loopbackHttp =
    environment !== "production" &&
    resource.protocol === "http:" &&
    isLoopback(resource.hostname);
  return resource.protocol === "https:" || loopbackHttp ? raw : null;
}

function parseScopes(raw: string | null): readonly string[] | null {
  if (raw === null) return null;
  const scopes = raw.split(" ");
  if (
    scopes.length < 1 ||
    scopes.length > 20 ||
    new Set(scopes).size !== scopes.length ||
    scopes.some((scope) => !scopePattern.test(scope)) ||
    !scopes.includes("openid") ||
    scopes.includes("offline_access")
  ) {
    return null;
  }
  return Object.freeze([...scopes]);
}

export function loadAdminWebConfig(
  environmentVariables: NodeJS.ProcessEnv = process.env,
): AdminWebConfig {
  const enabledValue = environmentVariables.ADMIN_WEB_ENABLED;
  if (enabledValue === undefined || enabledValue === "false") return { enabled: false };
  if (enabledValue !== "true") {
    throw new AdminWebConfigurationError(["ADMIN_WEB_ENABLED"]);
  }

  const environment = parseEnvironment(environmentVariables.NODE_ENV);
  if (environment === null) {
    throw new AdminWebConfigurationError(["NODE_ENV"]);
  }
  const issues: string[] = [];
  const publicOriginResult = parseUrl(
    present(environmentVariables.ADMIN_WEB_PUBLIC_ORIGIN),
    "ADMIN_WEB_PUBLIC_ORIGIN",
    environment,
    { originOnly: true, productionHttps: true },
  );
  if (publicOriginResult.issue) issues.push(publicOriginResult.issue);
  const issuerRaw = present(environmentVariables.ADMIN_WEB_OIDC_ISSUER);
  const issuerResult = parseUrl(issuerRaw, "ADMIN_WEB_OIDC_ISSUER", environment, {
    productionHttps: true,
  });
  if (
    issuerResult.issue ||
    issuerResult.url?.search !== "" ||
    issuerResult.url?.pathname.endsWith("/.well-known/openid-configuration")
  ) {
    issues.push("ADMIN_WEB_OIDC_ISSUER");
  }

  const resourceRaw = present(environmentVariables.ADMIN_WEB_OIDC_RESOURCE);
  const resource =
    resourceRaw === null ? null : parseResourceUri(resourceRaw, environment);
  if (resourceRaw !== null && resource === null) {
    issues.push("ADMIN_WEB_OIDC_RESOURCE");
  }

  const endpointRaw = present(environmentVariables.ADMIN_WEB_DYNAMODB_ENDPOINT);
  let endpoint: URL | null = null;
  if (endpointRaw !== null) {
    const endpointResult = parseUrl(
      endpointRaw,
      "ADMIN_WEB_DYNAMODB_ENDPOINT",
      environment,
      { originOnly: true },
    );
    endpoint = endpointResult.url;
    if (endpointResult.issue || environment === "production") {
      issues.push("ADMIN_WEB_DYNAMODB_ENDPOINT");
    }
  }

  const clientId = present(environmentVariables.ADMIN_WEB_OIDC_CLIENT_ID);
  if (
    clientId === null ||
    clientId.length > 200 ||
    !safeIdentifierPattern.test(clientId)
  ) {
    issues.push("ADMIN_WEB_OIDC_CLIENT_ID");
  }
  const clientSecret = present(environmentVariables.ADMIN_WEB_OIDC_CLIENT_SECRET);
  if (
    clientSecret === null ||
    clientSecret.length < 32 ||
    clientSecret.length > 512 ||
    !isPrintableAscii(clientSecret)
  ) {
    issues.push("ADMIN_WEB_OIDC_CLIENT_SECRET");
  }
  const scopes = parseScopes(present(environmentVariables.ADMIN_WEB_OIDC_SCOPES));
  if (scopes === null) issues.push("ADMIN_WEB_OIDC_SCOPES");

  const sessionStore = present(environmentVariables.ADMIN_WEB_SESSION_STORE);
  if (sessionStore !== "dynamodb") issues.push("ADMIN_WEB_SESSION_STORE");
  const sessionTable = present(environmentVariables.ADMIN_WEB_SESSION_TABLE);
  if (sessionTable === null || !tableNamePattern.test(sessionTable)) {
    issues.push("ADMIN_WEB_SESSION_TABLE");
  }
  const awsRegion = present(environmentVariables.AWS_REGION);
  if (awsRegion === null || !awsRegionPattern.test(awsRegion)) {
    issues.push("AWS_REGION");
  }
  const sessionEncryptionKey = parseEncryptionKey(
    present(environmentVariables.ADMIN_WEB_SESSION_ENCRYPTION_KEY_BASE64),
  );
  if (sessionEncryptionKey === null) {
    issues.push("ADMIN_WEB_SESSION_ENCRYPTION_KEY_BASE64");
  }
  const sessionTtlSeconds = parseInteger(
    environmentVariables.ADMIN_WEB_SESSION_TTL_SECONDS,
    28_800,
    900,
    86_400,
  );
  if (sessionTtlSeconds === null) issues.push("ADMIN_WEB_SESSION_TTL_SECONDS");
  const loginTtlSeconds = parseInteger(
    environmentVariables.ADMIN_WEB_LOGIN_TTL_SECONDS,
    300,
    60,
    900,
  );
  if (loginTtlSeconds === null) {
    issues.push("ADMIN_WEB_LOGIN_TTL_SECONDS");
  }

  if (issues.length > 0) throw new AdminWebConfigurationError(issues);
  if (
    !publicOriginResult.url ||
    !issuerResult.url ||
    !issuerRaw ||
    !clientId ||
    !clientSecret ||
    !scopes ||
    !sessionTable ||
    !awsRegion ||
    !sessionEncryptionKey ||
    sessionTtlSeconds === null ||
    loginTtlSeconds === null
  ) {
    throw new AdminWebConfigurationError(["ADMIN_WEB_CONFIGURATION"]);
  }

  const publicOrigin = publicOriginResult.url.origin;
  const secureCookies = publicOriginResult.url.protocol === "https:";
  return {
    awsRegion,
    callbackUrl: `${publicOrigin}/admin/auth/callback`,
    dynamodbEndpoint: endpoint?.origin ?? null,
    enabled: true,
    environment,
    loginCookieName: secureCookies
      ? ADMIN_LOGIN_COOKIE_NAMES.secure
      : ADMIN_LOGIN_COOKIE_NAMES.local,
    loginTtlSeconds,
    oidc: {
      clientId,
      clientSecret,
      issuer: issuerRaw,
      resource,
      scopes,
    },
    publicOrigin,
    secureCookies,
    sessionCookieName: secureCookies
      ? ADMIN_SESSION_COOKIE_NAMES.secure
      : ADMIN_SESSION_COOKIE_NAMES.local,
    sessionEncryptionKey,
    sessionStore: "dynamodb",
    sessionTable,
    sessionTtlSeconds,
  };
}

export function normalizeAdminReturnTo(value: string | null | undefined): string {
  if (
    value === null ||
    value === undefined ||
    value.length < 1 ||
    value.length > 2_048 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    [...value].some((character) => {
      const code = character.codePointAt(0);
      return code === undefined || code < 0x20 || code === 0x7f;
    })
  ) {
    return DEFAULT_ADMIN_RETURN_TO;
  }

  const rawPath = value.split(/[?#]/u, 1)[0] ?? "";
  if (rawPath.includes("%")) return DEFAULT_ADMIN_RETURN_TO;
  try {
    const parsed = new URL(value, "https://alphanet.invalid");
    if (
      parsed.origin !== "https://alphanet.invalid" ||
      (parsed.pathname !== "/admin" && !parsed.pathname.startsWith("/admin/"))
    ) {
      return DEFAULT_ADMIN_RETURN_TO;
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return DEFAULT_ADMIN_RETURN_TO;
  }
}

export function isAdminPostOriginAllowed(
  origin: string | null,
  config: EnabledAdminWebConfig,
): boolean {
  return origin !== null && origin === config.publicOrigin;
}
