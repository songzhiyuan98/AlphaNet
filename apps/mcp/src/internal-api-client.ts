import type { IncomingHttpHeaders } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";

import {
  createMcpActorContextAssertion,
  MCP_ACTOR_ASSERTION_MAX_TTL_SECONDS,
  type McpActorAssertionKeyRing,
} from "@alphanet/auth";

import type { McpToolExecutionContext } from "./protocol.js";

export const INTERNAL_API_DEFAULT_TIMEOUT_MILLISECONDS = 15_000;
export const INTERNAL_API_MAX_TIMEOUT_MILLISECONDS =
  MCP_ACTOR_ASSERTION_MAX_TTL_SECONDS * 1_000 - 1;
export const INTERNAL_API_DEFAULT_MAX_RESPONSE_BYTES = 4 * 1_024 * 1_024;
export const INTERNAL_API_MAX_REQUEST_BYTES = 1 * 1_024 * 1_024;
export const INTERNAL_MCP_API_PATH_PREFIX = "/internal/mcp/v1/";

const MAX_TLS_MATERIAL_BYTES = 1 * 1_024 * 1_024;
const MAX_INTERNAL_PATH_BYTES = 8 * 1_024;
const CANONICAL_REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type InternalApiTlsMaterial = string | Buffer;

export interface InternalApiTlsOptions {
  ca: InternalApiTlsMaterial;
  cert: InternalApiTlsMaterial;
  key: InternalApiTlsMaterial;
  minVersion: "TLSv1.2";
  rejectUnauthorized: true;
  servername?: string | undefined;
}

export interface InternalApiTransportRequest {
  body?: Buffer | undefined;
  headers: Readonly<Record<string, string>>;
  maxResponseBytes: number;
  method: "GET" | "POST";
  signal: AbortSignal;
  timeoutMilliseconds: number;
  tls: InternalApiTlsOptions;
  url: URL;
}

export interface InternalApiTransportResponse {
  body: Buffer;
  headers: Readonly<IncomingHttpHeaders>;
  statusCode: number;
}

export type InternalApiRequestTransport = (
  request: InternalApiTransportRequest,
) => Promise<InternalApiTransportResponse>;

export interface InternalMcpApiClientConfig {
  assertionKeyRing: McpActorAssertionKeyRing;
  baseUrl: string;
  maxResponseBytes?: number | undefined;
  servername?: string | undefined;
  timeoutMilliseconds?: number | undefined;
  tls: {
    ca: InternalApiTlsMaterial;
    cert: InternalApiTlsMaterial;
    key: InternalApiTlsMaterial;
  };
}

export interface InternalMcpApiRequest<Output> {
  body?: unknown;
  method: "GET" | "POST";
  /** Must stay within the dedicated private MCP API namespace. */
  path: string;
  /** Shared Contracts parsers can be supplied directly here. */
  parseResponse: (value: unknown) => Output;
}

export interface InternalMcpApiResponse<Output> {
  payload: Output;
  statusCode: number;
}

export interface InternalMcpApiClient {
  request<Output>(
    request: InternalMcpApiRequest<Output>,
    context: McpToolExecutionContext,
  ): Promise<InternalMcpApiResponse<Output>>;
}

export type InternalMcpApiClientErrorCode =
  | "ABORTED"
  | "ASSERTION_UNAVAILABLE"
  | "CONFIGURATION_INVALID"
  | "INVALID_REQUEST"
  | "INVALID_RESPONSE"
  | "REDIRECT_REJECTED"
  | "RESPONSE_TOO_LARGE"
  | "TIMEOUT"
  | "TRANSPORT_UNAVAILABLE";

const ERROR_MESSAGES: Readonly<Record<InternalMcpApiClientErrorCode, string>> = {
  ABORTED: "Internal API request was cancelled.",
  ASSERTION_UNAVAILABLE: "Internal API identity assertion is unavailable.",
  CONFIGURATION_INVALID: "Internal API client configuration is invalid.",
  INVALID_REQUEST: "Internal API request is invalid.",
  INVALID_RESPONSE: "Internal API returned an invalid response.",
  REDIRECT_REJECTED: "Internal API redirects are not allowed.",
  RESPONSE_TOO_LARGE: "Internal API response exceeds the configured limit.",
  TIMEOUT: "Internal API request timed out.",
  TRANSPORT_UNAVAILABLE: "Internal API transport is unavailable.",
};

export class InternalMcpApiClientError extends Error {
  readonly code: InternalMcpApiClientErrorCode;

  constructor(code: InternalMcpApiClientErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "InternalMcpApiClientError";
    this.code = code;
  }
}

class NativeTransportError extends Error {
  readonly code: "ABORTED" | "RESPONSE_TOO_LARGE" | "TIMEOUT" | "UNAVAILABLE";

  constructor(code: NativeTransportError["code"]) {
    super(code);
    this.name = "NativeTransportError";
    this.code = code;
  }
}

function failConfiguration(): never {
  throw new InternalMcpApiClientError("CONFIGURATION_INVALID");
}

function validateBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return failConfiguration();
  }
  if (
    value.trim() !== value ||
    Buffer.byteLength(value, "utf8") > 2_048 ||
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    (value !== url.origin && value !== url.toString())
  ) {
    return failConfiguration();
  }
  return url;
}

function copyTlsMaterial(value: InternalApiTlsMaterial): InternalApiTlsMaterial {
  if (typeof value !== "string" && !Buffer.isBuffer(value)) {
    return failConfiguration();
  }
  const byteLength = Buffer.byteLength(value);
  if (byteLength < 1 || byteLength > MAX_TLS_MATERIAL_BYTES) {
    return failConfiguration();
  }
  return Buffer.isBuffer(value) ? Buffer.from(value) : value;
}

function validateServername(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (
    value.length < 1 ||
    value.length > 253 ||
    value.toLowerCase() !== value ||
    !/^[a-z0-9.-]+$/u.test(value) ||
    value.startsWith(".") ||
    value.endsWith(".") ||
    value.includes("..")
  ) {
    return failConfiguration();
  }
  return value;
}

function hasHttpWhitespaceOrControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x20 || codePoint === 0x7f);
  });
}

function validatePositiveInteger(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    return failConfiguration();
  }
  return value;
}

function resolveInternalUrl(baseUrl: URL, path: string): URL {
  if (
    typeof path !== "string" ||
    path.length < 1 ||
    Buffer.byteLength(path, "utf8") > MAX_INTERNAL_PATH_BYTES ||
    !path.startsWith(INTERNAL_MCP_API_PATH_PREFIX) ||
    path.includes("\\") ||
    hasHttpWhitespaceOrControl(path)
  ) {
    throw new InternalMcpApiClientError("INVALID_REQUEST");
  }

  let url: URL;
  try {
    url = new URL(path, baseUrl);
  } catch {
    throw new InternalMcpApiClientError("INVALID_REQUEST");
  }
  if (
    url.origin !== baseUrl.origin ||
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    !url.pathname.startsWith(INTERNAL_MCP_API_PATH_PREFIX) ||
    `${url.pathname}${url.search}` !== path
  ) {
    throw new InternalMcpApiClientError("INVALID_REQUEST");
  }
  return url;
}

function serializeRequestBody(
  method: "GET" | "POST",
  value: unknown,
): Buffer | undefined {
  if (method === "GET") {
    if (value !== undefined) {
      throw new InternalMcpApiClientError("INVALID_REQUEST");
    }
    return undefined;
  }
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InternalMcpApiClientError("INVALID_REQUEST");
  }

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new InternalMcpApiClientError("INVALID_REQUEST");
  }
  if (serialized === undefined) {
    throw new InternalMcpApiClientError("INVALID_REQUEST");
  }
  const body = Buffer.from(serialized, "utf8");
  if (body.byteLength > INTERNAL_API_MAX_REQUEST_BYTES) {
    throw new InternalMcpApiClientError("INVALID_REQUEST");
  }
  return body;
}

function headerValue(
  headers: Readonly<IncomingHttpHeaders>,
  expectedName: string,
): string | undefined {
  const entries = Object.entries(headers).filter(
    ([name]) => name.toLowerCase() === expectedName,
  );
  if (entries.length !== 1) return undefined;
  const value = entries[0]?.[1];
  return typeof value === "string" ? value : undefined;
}

function headerEntryCount(
  headers: Readonly<IncomingHttpHeaders>,
  expectedName: string,
): number {
  return Object.keys(headers).filter((name) => name.toLowerCase() === expectedName)
    .length;
}

function validJsonContentType(value: string | undefined): boolean {
  if (!value) return false;
  const parts = value.split(";").map((part) => part.trim().toLowerCase());
  if (parts[0] !== "application/json") return false;
  return parts.length === 1 || (parts.length === 2 && parts[1] === "charset=utf-8");
}

function parseJsonResponse<Output>(
  response: InternalApiTransportResponse,
  maximumBytes: number,
  parser: (value: unknown) => Output,
): InternalMcpApiResponse<Output> {
  if (
    typeof response !== "object" ||
    response === null ||
    !Number.isSafeInteger(response.statusCode) ||
    response.statusCode < 200 ||
    response.statusCode > 599 ||
    !Buffer.isBuffer(response.body) ||
    typeof response.headers !== "object" ||
    response.headers === null ||
    Array.isArray(response.headers)
  ) {
    throw new InternalMcpApiClientError("INVALID_RESPONSE");
  }
  if (response.statusCode >= 300 && response.statusCode <= 399) {
    throw new InternalMcpApiClientError("REDIRECT_REJECTED");
  }
  if (response.body.byteLength > maximumBytes) {
    throw new InternalMcpApiClientError("RESPONSE_TOO_LARGE");
  }
  if (
    response.body.byteLength < 1 ||
    headerEntryCount(response.headers, "content-type") !== 1 ||
    !validJsonContentType(headerValue(response.headers, "content-type"))
  ) {
    throw new InternalMcpApiClientError("INVALID_RESPONSE");
  }
  const contentEncoding = headerValue(response.headers, "content-encoding");
  if (
    headerEntryCount(response.headers, "content-encoding") > 1 ||
    (contentEncoding !== undefined && contentEncoding.toLowerCase() !== "identity")
  ) {
    throw new InternalMcpApiClientError("INVALID_RESPONSE");
  }
  const contentLength = headerValue(response.headers, "content-length");
  if (
    headerEntryCount(response.headers, "content-length") > 1 ||
    (contentLength !== undefined &&
      (!/^(0|[1-9][0-9]*)$/u.test(contentLength) ||
        !Number.isSafeInteger(Number(contentLength)) ||
        Number(contentLength) !== response.body.byteLength))
  ) {
    throw new InternalMcpApiClientError("INVALID_RESPONSE");
  }

  let decoded: string;
  let json: unknown;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
    json = JSON.parse(decoded) as unknown;
  } catch {
    throw new InternalMcpApiClientError("INVALID_RESPONSE");
  }

  try {
    return Object.freeze({
      payload: parser(json),
      statusCode: response.statusCode,
    });
  } catch {
    throw new InternalMcpApiClientError("INVALID_RESPONSE");
  }
}

function copyResponseHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const copy: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    copy[name] = Array.isArray(value) ? [...value] : value;
  }
  return copy;
}

/** Default transport: one native Node HTTPS request, with no redirect or retry layer. */
export const nodeHttpsInternalApiTransport: InternalApiRequestTransport = async (input) =>
  new Promise<InternalApiTransportResponse>((resolve, reject) => {
    let settled = false;
    const settle = (
      outcome:
        | { ok: true; value: InternalApiTransportResponse }
        | { error: NativeTransportError; ok: false },
    ): void => {
      if (settled) return;
      settled = true;
      if (outcome.ok) resolve(outcome.value);
      else reject(outcome.error);
    };

    const options: RequestOptions = {
      ca: input.tls.ca,
      cert: input.tls.cert,
      headers: { ...input.headers },
      hostname: input.url.hostname,
      key: input.tls.key,
      method: input.method,
      minVersion: input.tls.minVersion,
      path: `${input.url.pathname}${input.url.search}`,
      port: input.url.port || undefined,
      protocol: "https:",
      rejectUnauthorized: input.tls.rejectUnauthorized,
      signal: input.signal,
      ...(input.tls.servername ? { servername: input.tls.servername } : {}),
    };

    let nativeRequest: ReturnType<typeof httpsRequest>;
    try {
      nativeRequest = httpsRequest(options, (response) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;

        response.on("data", (chunk: Buffer | string) => {
          if (settled) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += bytes.byteLength;
          if (totalBytes > input.maxResponseBytes) {
            response.destroy();
            settle({
              error: new NativeTransportError("RESPONSE_TOO_LARGE"),
              ok: false,
            });
            return;
          }
          chunks.push(bytes);
        });
        response.once("aborted", () => {
          settle({ error: new NativeTransportError("UNAVAILABLE"), ok: false });
        });
        response.once("error", () => {
          settle({ error: new NativeTransportError("UNAVAILABLE"), ok: false });
        });
        response.once("end", () => {
          settle({
            ok: true,
            value: {
              body: Buffer.concat(chunks, totalBytes),
              headers: copyResponseHeaders(response.headers),
              statusCode: response.statusCode ?? 0,
            },
          });
        });
      });
    } catch {
      settle({ error: new NativeTransportError("UNAVAILABLE"), ok: false });
      return;
    }

    nativeRequest.setTimeout(input.timeoutMilliseconds, () => {
      nativeRequest.destroy(new NativeTransportError("TIMEOUT"));
    });
    nativeRequest.once("error", (error: unknown) => {
      if (error instanceof NativeTransportError) {
        settle({ error, ok: false });
        return;
      }
      settle({
        error: new NativeTransportError(input.signal.aborted ? "ABORTED" : "UNAVAILABLE"),
        ok: false,
      });
    });
    if (input.body) nativeRequest.end(input.body);
    else nativeRequest.end();
  });

function mapTransportError(error: unknown): InternalMcpApiClientError {
  if (!(error instanceof NativeTransportError)) {
    return new InternalMcpApiClientError("TRANSPORT_UNAVAILABLE");
  }
  switch (error.code) {
    case "ABORTED":
      return new InternalMcpApiClientError("ABORTED");
    case "RESPONSE_TOO_LARGE":
      return new InternalMcpApiClientError("RESPONSE_TOO_LARGE");
    case "TIMEOUT":
      return new InternalMcpApiClientError("TIMEOUT");
    case "UNAVAILABLE":
      return new InternalMcpApiClientError("TRANSPORT_UNAVAILABLE");
  }
}

/**
 * Creates the MCP-to-API trust client. The caller cannot provide arbitrary
 * outbound headers or an origin; every call gets a fresh, request-bound Actor
 * Context assertion and the allowlisted internal headers only.
 */
export function createInternalMcpApiClient(
  config: InternalMcpApiClientConfig,
  dependencies: {
    now?: (() => Date) | undefined;
    transport?: InternalApiRequestTransport | undefined;
  } = {},
): InternalMcpApiClient {
  const baseUrl = validateBaseUrl(config.baseUrl);
  const timeoutMilliseconds = validatePositiveInteger(
    config.timeoutMilliseconds ?? INTERNAL_API_DEFAULT_TIMEOUT_MILLISECONDS,
    INTERNAL_API_MAX_TIMEOUT_MILLISECONDS,
  );
  const maxResponseBytes = validatePositiveInteger(
    config.maxResponseBytes ?? INTERNAL_API_DEFAULT_MAX_RESPONSE_BYTES,
    INTERNAL_API_DEFAULT_MAX_RESPONSE_BYTES,
  );
  const tls: InternalApiTlsOptions = Object.freeze({
    ca: copyTlsMaterial(config.tls.ca),
    cert: copyTlsMaterial(config.tls.cert),
    key: copyTlsMaterial(config.tls.key),
    minVersion: "TLSv1.2",
    rejectUnauthorized: true,
    ...(config.servername !== undefined
      ? { servername: validateServername(config.servername) }
      : {}),
  });
  const transport = dependencies.transport ?? nodeHttpsInternalApiTransport;

  return Object.freeze({
    request: async <Output>(
      request: InternalMcpApiRequest<Output>,
      context: McpToolExecutionContext,
    ): Promise<InternalMcpApiResponse<Output>> => {
      if (context.signal.aborted) {
        throw new InternalMcpApiClientError("ABORTED");
      }
      if (!CANONICAL_REQUEST_ID.test(context.requestId)) {
        throw new InternalMcpApiClientError("INVALID_REQUEST");
      }
      if (request.method !== "GET" && request.method !== "POST") {
        throw new InternalMcpApiClientError("INVALID_REQUEST");
      }
      const url = resolveInternalUrl(baseUrl, request.path);
      const body = serializeRequestBody(request.method, request.body);

      let now: Date;
      let assertion: string;
      try {
        now = dependencies.now ? dependencies.now() : new Date();
        if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) {
          throw new Error("invalid clock");
        }
        const issuedAt = Math.floor(now.valueOf() / 1_000);
        const accessTokenExpiresAt = context.authorization.expiresAt;
        if (
          !Number.isSafeInteger(accessTokenExpiresAt) ||
          accessTokenExpiresAt <= issuedAt
        ) {
          throw new Error("invalid access-token expiry");
        }
        const assertionTtlSeconds = Math.min(
          MCP_ACTOR_ASSERTION_MAX_TTL_SECONDS,
          accessTokenExpiresAt - issuedAt,
        );
        assertion = await createMcpActorContextAssertion(
          {
            credentialId: context.authorization.credentialId,
            grantId: context.authorization.grantId,
            requestId: context.requestId,
            scopes: context.authorization.scopes,
            tokenJtiDigest: context.authorization.tokenJtiDigest,
          },
          config.assertionKeyRing,
          { now: new Date(now.valueOf()), ttlSeconds: assertionTtlSeconds },
        );
      } catch {
        throw new InternalMcpApiClientError("ASSERTION_UNAVAILABLE");
      }
      if (context.signal.aborted) {
        throw new InternalMcpApiClientError("ABORTED");
      }

      const headers: Record<string, string> = {
        accept: "application/json",
        "x-alphanet-mcp-actor-context": assertion,
        "x-request-id": context.requestId,
      };
      if (body) {
        headers["content-length"] = String(body.byteLength);
        headers["content-type"] = "application/json";
      }

      const controller = new AbortController();
      let timedOut = false;
      const forwardAbort = (): void => controller.abort();
      const aborted = new Promise<never>((_resolve, reject) => {
        const rejectAborted = (): void => reject(new NativeTransportError("ABORTED"));
        if (controller.signal.aborted) rejectAborted();
        else {
          controller.signal.addEventListener("abort", rejectAborted, {
            once: true,
          });
        }
      });
      context.signal.addEventListener("abort", forwardAbort, { once: true });
      if (context.signal.aborted) controller.abort();
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMilliseconds);

      try {
        const response = await Promise.race([
          transport({
            ...(body ? { body } : {}),
            headers: Object.freeze({ ...headers }),
            maxResponseBytes,
            method: request.method,
            signal: controller.signal,
            timeoutMilliseconds,
            tls,
            url,
          }),
          aborted,
        ]);
        return parseJsonResponse(response, maxResponseBytes, request.parseResponse);
      } catch (error) {
        if (error instanceof InternalMcpApiClientError) throw error;
        if (timedOut) throw new InternalMcpApiClientError("TIMEOUT");
        if (context.signal.aborted) {
          throw new InternalMcpApiClientError("ABORTED");
        }
        throw mapTransportError(error);
      } finally {
        clearTimeout(timeout);
        context.signal.removeEventListener("abort", forwardAbort);
      }
    },
  });
}
