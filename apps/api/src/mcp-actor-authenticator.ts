import {
  McpActorContextAssertionError,
  verifyMcpActorContextAssertion,
  type McpActorAssertionKeyRing,
  type McpActorAssertionReplayStore,
} from "@alphanet/auth";
import {
  AgentConnectionError,
  type AgentCredentialContext,
  type RemoteMcpAuthorityService,
} from "@alphanet/domain";

export const REMOTE_MCP_ACTOR_ASSERTION_MAX_BYTES = 8_192;
export const REMOTE_MCP_REQUEST_ID_MAX_BYTES = 200;

export type RemoteMcpActorAuthenticationErrorCode =
  | "REMOTE_MCP_ACTOR_AUTHENTICATION_FAILED"
  | "REMOTE_MCP_ACTOR_AUTHENTICATION_UNAVAILABLE";

const authenticationErrorProperties = {
  REMOTE_MCP_ACTOR_AUTHENTICATION_FAILED: {
    message: "Remote MCP ActorContext authentication failed.",
    retryable: false,
    statusCode: 401,
  },
  REMOTE_MCP_ACTOR_AUTHENTICATION_UNAVAILABLE: {
    message: "Remote MCP ActorContext authentication is temporarily unavailable.",
    retryable: true,
    statusCode: 503,
  },
} as const satisfies Record<
  RemoteMcpActorAuthenticationErrorCode,
  { message: string; retryable: boolean; statusCode: number }
>;

/**
 * A deliberately non-diagnostic error for the private MCP-to-API trust boundary.
 * Callers may log the code, but must never log the assertion or attach a source
 * error to an HTTP response.
 */
export class RemoteMcpActorAuthenticationError extends Error {
  readonly code: RemoteMcpActorAuthenticationErrorCode;
  readonly retryable: boolean;
  readonly statusCode: number;

  constructor(code: RemoteMcpActorAuthenticationErrorCode) {
    const properties = authenticationErrorProperties[code];
    super(properties.message);
    this.name = "RemoteMcpActorAuthenticationError";
    this.code = code;
    this.retryable = properties.retryable;
    this.statusCode = properties.statusCode;
  }
}

export interface AuthenticateRemoteMcpActorInput {
  /** The raw, single-valued private ActorContext assertion header. */
  assertion: unknown;
  /** The server-generated request ID for this API request. */
  requestId: unknown;
}

export interface RemoteMcpActorAuthenticator {
  authenticate(input: AuthenticateRemoteMcpActorInput): Promise<AgentCredentialContext>;
}

export interface RemoteMcpActorAuthenticatorOptions {
  authority: Pick<RemoteMcpAuthorityService, "authenticateActorContext">;
  keyRing: McpActorAssertionKeyRing;
  now?: (() => Date) | undefined;
  replayStore: McpActorAssertionReplayStore;
}

function utf8ByteLengthWithin(value: string, maximum: number): boolean {
  return Buffer.byteLength(value, "utf8") <= maximum;
}

function parseSingleAssertion(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > REMOTE_MCP_ACTOR_ASSERTION_MAX_BYTES ||
    !utf8ByteLengthWithin(value, REMOTE_MCP_ACTOR_ASSERTION_MAX_BYTES) ||
    value.trim() !== value
  ) {
    throw new RemoteMcpActorAuthenticationError("REMOTE_MCP_ACTOR_AUTHENTICATION_FAILED");
  }
  return value;
}

function parseRequestId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > REMOTE_MCP_REQUEST_ID_MAX_BYTES ||
    !utf8ByteLengthWithin(value, REMOTE_MCP_REQUEST_ID_MAX_BYTES)
  ) {
    throw new RemoteMcpActorAuthenticationError("REMOTE_MCP_ACTOR_AUTHENTICATION_FAILED");
  }
  return value;
}

function authenticationFailed(): RemoteMcpActorAuthenticationError {
  return new RemoteMcpActorAuthenticationError("REMOTE_MCP_ACTOR_AUTHENTICATION_FAILED");
}

function authenticationUnavailable(): RemoteMcpActorAuthenticationError {
  return new RemoteMcpActorAuthenticationError(
    "REMOTE_MCP_ACTOR_AUTHENTICATION_UNAVAILABLE",
  );
}

function readNow(clock: () => Date): Date {
  let now: Date;
  try {
    now = clock();
  } catch {
    throw authenticationUnavailable();
  }
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) {
    throw authenticationUnavailable();
  }
  return new Date(now.valueOf());
}

/**
 * Authenticates one private MCP-to-API request. The order is security relevant:
 * signed claims, exact request binding, one-shot replay consumption, then live
 * database authority. No external Bearer token and no fallback credential path
 * are accepted here.
 */
export class DefaultRemoteMcpActorAuthenticator implements RemoteMcpActorAuthenticator {
  readonly #authority: Pick<RemoteMcpAuthorityService, "authenticateActorContext">;
  readonly #keyRing: McpActorAssertionKeyRing;
  readonly #now: () => Date;
  readonly #replayStore: McpActorAssertionReplayStore;

  constructor(options: RemoteMcpActorAuthenticatorOptions) {
    this.#authority = options.authority;
    this.#keyRing = options.keyRing;
    this.#now = options.now ?? (() => new Date());
    this.#replayStore = options.replayStore;
  }

  async authenticate(
    input: AuthenticateRemoteMcpActorInput,
  ): Promise<AgentCredentialContext> {
    const assertion = parseSingleAssertion(input.assertion);
    const requestId = parseRequestId(input.requestId);
    const now = readNow(this.#now);

    let verified;
    try {
      verified = await verifyMcpActorContextAssertion(assertion, this.#keyRing, now);
    } catch (error) {
      if (error instanceof McpActorContextAssertionError) {
        if (error.code === "ASSERTION_KEY_INVALID") {
          throw authenticationUnavailable();
        }
        throw authenticationFailed();
      }
      throw authenticationUnavailable();
    }

    if (verified.requestId !== requestId) {
      throw authenticationFailed();
    }

    let consumed: boolean;
    try {
      consumed = await this.#replayStore.consume(verified.jti, verified.expiresAt, now);
    } catch {
      throw authenticationUnavailable();
    }
    if (consumed !== true) {
      if (consumed !== false) {
        throw authenticationUnavailable();
      }
      throw authenticationFailed();
    }

    try {
      return await this.#authority.authenticateActorContext({
        credentialId: verified.credentialId,
        grantId: verified.grantId,
        scopes: [...verified.scopes],
        tokenJtiDigest: verified.tokenJtiDigest,
      });
    } catch (error) {
      if (error instanceof AgentConnectionError && error.code === "INVALID_CREDENTIAL") {
        throw authenticationFailed();
      }
      throw authenticationUnavailable();
    }
  }
}

export function createRemoteMcpActorAuthenticator(
  options: RemoteMcpActorAuthenticatorOptions,
): RemoteMcpActorAuthenticator {
  return new DefaultRemoteMcpActorAuthenticator(options);
}
