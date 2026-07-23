const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REQUEST_ID_MAX_LENGTH = 200;
const SESSION_CONTEXT_KEYS = [
  "authenticatedAt",
  "authenticationAssurance",
  "ownerId",
  "requestId",
  "sessionId",
] as const;
const OWNER_WEB_CONTEXT_BRAND = Symbol("OwnerWebContext");

export type OwnerWebAuthenticationAssurance = "owner_session" | "fresh_owner_session";

export interface OwnerWebSessionContext {
  /** Type-level nominal marker; runtime authority is held in instance-private WeakMaps. */
  readonly [OWNER_WEB_CONTEXT_BRAND]: "mutation" | "session";
  readonly ownerId: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly authenticatedAt: Date;
  readonly authenticationAssurance: OwnerWebAuthenticationAssurance;
}

export interface OwnerWebMutationContext extends OwnerWebSessionContext {
  readonly [OWNER_WEB_CONTEXT_BRAND]: "mutation";
  readonly csrfValidated: true;
}

export interface OwnerWebSessionContextFacts {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly authenticatedAt: Date;
  readonly authenticationAssurance: OwnerWebAuthenticationAssurance;
}

export interface OwnerWebContextIssuer {
  readonly issueMutationContext: (value: unknown) => OwnerWebMutationContext;
  readonly issueSessionContext: (value: unknown) => OwnerWebSessionContext;
}

export interface OwnerWebContextVerifier {
  readonly assertMutationContext: (
    value: unknown,
    databaseCheckedAt: Date,
  ) => asserts value is OwnerWebMutationContext;
  readonly assertSessionContext: (
    value: unknown,
    databaseCheckedAt: Date,
  ) => asserts value is OwnerWebSessionContext;
  readonly normalizeMutationContext: (
    value: unknown,
    databaseCheckedAt: Date,
  ) => OwnerWebMutationContext;
  readonly normalizeSessionContext: (
    value: unknown,
    databaseCheckedAt: Date,
  ) => OwnerWebSessionContext;
}

export interface OwnerWebContextAuthority {
  readonly issuer: OwnerWebContextIssuer;
  readonly verifier: OwnerWebContextVerifier;
}

interface NormalizedOwnerWebSessionSnapshot {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly authenticatedAtMilliseconds: number;
  readonly authenticationAssurance: OwnerWebAuthenticationAssurance;
}

export type OwnerWebSessionContextErrorCode =
  | "INVALID_DATABASE_CHECKED_AT"
  | "INVALID_OWNER_WEB_SESSION_CONTEXT"
  | "OWNER_WEB_AUTHENTICATION_TIME_INVALID"
  | "OWNER_WEB_CSRF_REQUIRED";

const ERROR_DEFINITIONS = {
  INVALID_DATABASE_CHECKED_AT: {
    message: "The database authority time is invalid.",
    retryable: false,
    statusCode: 500,
  },
  INVALID_OWNER_WEB_SESSION_CONTEXT: {
    message: "The Owner Web session context is invalid.",
    retryable: false,
    statusCode: 400,
  },
  OWNER_WEB_AUTHENTICATION_TIME_INVALID: {
    message: "The Owner Web authentication time is invalid.",
    retryable: false,
    statusCode: 401,
  },
  OWNER_WEB_CSRF_REQUIRED: {
    message: "A validated CSRF boundary is required for this Owner Web mutation.",
    retryable: false,
    statusCode: 403,
  },
} as const satisfies Record<
  OwnerWebSessionContextErrorCode,
  Readonly<{ message: string; retryable: boolean; statusCode: number }>
>;

export class OwnerWebSessionContextError extends Error {
  readonly code: OwnerWebSessionContextErrorCode;
  readonly retryable: boolean;
  readonly statusCode: number;

  constructor(code: OwnerWebSessionContextErrorCode) {
    const definition = ERROR_DEFINITIONS[code];
    super(definition.message);
    this.name = "OwnerWebSessionContextError";
    this.code = code;
    this.retryable = definition.retryable;
    this.statusCode = definition.statusCode;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value) as unknown;
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  try {
    const ownKeys = Reflect.ownKeys(value);
    if (!ownKeys.every((key): key is string => typeof key === "string")) return false;
    const actual = ownKeys.sort();
    const sortedExpected = [...expected].sort();
    return (
      actual.length === sortedExpected.length &&
      actual.every((key, index) => key === sortedExpected[index])
    );
  } catch {
    return false;
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function finiteDateMilliseconds(value: unknown): number | null {
  if (!(value instanceof Date)) return null;
  try {
    const milliseconds = Date.prototype.getTime.call(value);
    return Number.isFinite(milliseconds) ? milliseconds : null;
  } catch {
    return null;
  }
}

function isAuthenticationAssurance(
  value: unknown,
): value is OwnerWebAuthenticationAssurance {
  return value === "owner_session" || value === "fresh_owner_session";
}

function requestIdIsValid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= 1 &&
    value.length <= REQUEST_ID_MAX_LENGTH &&
    !value.includes("\0")
  );
}

function databaseCheckedAtMilliseconds(databaseCheckedAt: Date): number {
  const milliseconds = finiteDateMilliseconds(databaseCheckedAt);
  if (milliseconds === null) {
    throw new OwnerWebSessionContextError("INVALID_DATABASE_CHECKED_AT");
  }
  return milliseconds;
}

const INVALID_DATA_PROPERTY = Symbol("invalid-data-property");

function ownDataProperty(value: Readonly<Record<string, unknown>>, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : INVALID_DATA_PROPERTY;
  } catch {
    return INVALID_DATA_PROPERTY;
  }
}

function assertAuthenticationTime(
  authenticatedAtMilliseconds: number,
  checkedAtMilliseconds: number,
): void {
  if (authenticatedAtMilliseconds > checkedAtMilliseconds) {
    throw new OwnerWebSessionContextError("OWNER_WEB_AUTHENTICATION_TIME_INVALID");
  }
}

function normalizeBaseSnapshot(
  value: Readonly<Record<string, unknown>>,
): NormalizedOwnerWebSessionSnapshot {
  const ownerId = ownDataProperty(value, "ownerId");
  const sessionId = ownDataProperty(value, "sessionId");
  const requestId = ownDataProperty(value, "requestId");
  const authenticatedAt = ownDataProperty(value, "authenticatedAt");
  const authenticationAssurance = ownDataProperty(value, "authenticationAssurance");
  const authenticatedAtMilliseconds = finiteDateMilliseconds(authenticatedAt);
  if (
    !isUuid(ownerId) ||
    !isUuid(sessionId) ||
    !requestIdIsValid(requestId) ||
    authenticatedAtMilliseconds === null ||
    !isAuthenticationAssurance(authenticationAssurance)
  ) {
    throw new OwnerWebSessionContextError("INVALID_OWNER_WEB_SESSION_CONTEXT");
  }
  return Object.freeze({
    ownerId,
    sessionId,
    requestId,
    authenticatedAtMilliseconds,
    authenticationAssurance,
  });
}

function buildSessionContext(
  snapshot: NormalizedOwnerWebSessionSnapshot,
  normalizedSessionSnapshots: WeakMap<object, NormalizedOwnerWebSessionSnapshot>,
): OwnerWebSessionContext {
  const context = {
    ownerId: snapshot.ownerId,
    sessionId: snapshot.sessionId,
    requestId: snapshot.requestId,
    // A getter returns a detached Date on every read. Freezing a Date does not
    // freeze its internal time value, so retaining one mutable Date here would
    // make the otherwise frozen authority context misleading.
    get authenticatedAt(): Date {
      return new Date(snapshot.authenticatedAtMilliseconds);
    },
    authenticationAssurance: snapshot.authenticationAssurance,
  } as OwnerWebSessionContext;
  Object.defineProperty(context, OWNER_WEB_CONTEXT_BRAND, {
    configurable: false,
    enumerable: false,
    value: "session",
    writable: false,
  });
  Object.freeze(context);
  normalizedSessionSnapshots.set(context, snapshot);
  return context;
}

function buildMutationContext(
  snapshot: NormalizedOwnerWebSessionSnapshot,
  normalizedSessionSnapshots: WeakMap<object, NormalizedOwnerWebSessionSnapshot>,
  normalizedMutationSnapshots: WeakMap<object, NormalizedOwnerWebSessionSnapshot>,
): OwnerWebMutationContext {
  const context = {
    ownerId: snapshot.ownerId,
    sessionId: snapshot.sessionId,
    requestId: snapshot.requestId,
    get authenticatedAt(): Date {
      return new Date(snapshot.authenticatedAtMilliseconds);
    },
    authenticationAssurance: snapshot.authenticationAssurance,
    csrfValidated: true as const,
  } as OwnerWebMutationContext;
  Object.defineProperty(context, OWNER_WEB_CONTEXT_BRAND, {
    configurable: false,
    enumerable: false,
    value: "mutation",
    writable: false,
  });
  Object.freeze(context);
  // A CSRF-validated mutation context is also a trusted authenticated session
  // context, so it can safely be used for read-only domain operations.
  normalizedSessionSnapshots.set(context, snapshot);
  normalizedMutationSnapshots.set(context, snapshot);
  return context;
}

/**
 * Creates paired, instance-scoped capabilities for issuing and verifying Owner
 * Web contexts. Only the issuer can add objects to this authority's WeakMaps;
 * the verifier rejects structurally identical values and contexts from every
 * other authority instance.
 */
export function createOwnerWebContextAuthority(): OwnerWebContextAuthority {
  const normalizedSessionSnapshots = new WeakMap<
    object,
    NormalizedOwnerWebSessionSnapshot
  >();
  const normalizedMutationSnapshots = new WeakMap<
    object,
    NormalizedOwnerWebSessionSnapshot
  >();

  function issueSnapshot(value: unknown): NormalizedOwnerWebSessionSnapshot {
    if (!isPlainRecord(value) || !hasExactKeys(value, SESSION_CONTEXT_KEYS)) {
      throw new OwnerWebSessionContextError("INVALID_OWNER_WEB_SESSION_CONTEXT");
    }
    return normalizeBaseSnapshot(value);
  }

  function normalizeSessionContext(
    value: unknown,
    databaseCheckedAt: Date,
  ): OwnerWebSessionContext {
    const checkedAtMilliseconds = databaseCheckedAtMilliseconds(databaseCheckedAt);
    if (typeof value === "object" && value !== null) {
      const normalizedSnapshot = normalizedSessionSnapshots.get(value);
      if (normalizedSnapshot !== undefined) {
        assertAuthenticationTime(
          normalizedSnapshot.authenticatedAtMilliseconds,
          checkedAtMilliseconds,
        );
        return buildSessionContext(normalizedSnapshot, normalizedSessionSnapshots);
      }
    }
    throw new OwnerWebSessionContextError("INVALID_OWNER_WEB_SESSION_CONTEXT");
  }

  function normalizeMutationContext(
    value: unknown,
    databaseCheckedAt: Date,
  ): OwnerWebMutationContext {
    const checkedAtMilliseconds = databaseCheckedAtMilliseconds(databaseCheckedAt);
    if (typeof value === "object" && value !== null) {
      const normalizedSnapshot = normalizedMutationSnapshots.get(value);
      if (normalizedSnapshot !== undefined) {
        assertAuthenticationTime(
          normalizedSnapshot.authenticatedAtMilliseconds,
          checkedAtMilliseconds,
        );
        return buildMutationContext(
          normalizedSnapshot,
          normalizedSessionSnapshots,
          normalizedMutationSnapshots,
        );
      }
      if (normalizedSessionSnapshots.has(value)) {
        throw new OwnerWebSessionContextError("OWNER_WEB_CSRF_REQUIRED");
      }
    }
    throw new OwnerWebSessionContextError("INVALID_OWNER_WEB_SESSION_CONTEXT");
  }

  function assertSessionContext(
    value: unknown,
    databaseCheckedAt: Date,
  ): asserts value is OwnerWebSessionContext {
    normalizeSessionContext(value, databaseCheckedAt);
  }

  function assertMutationContext(
    value: unknown,
    databaseCheckedAt: Date,
  ): asserts value is OwnerWebMutationContext {
    normalizeMutationContext(value, databaseCheckedAt);
  }

  const issuer: OwnerWebContextIssuer = Object.freeze({
    issueMutationContext: (value: unknown): OwnerWebMutationContext =>
      buildMutationContext(
        issueSnapshot(value),
        normalizedSessionSnapshots,
        normalizedMutationSnapshots,
      ),
    issueSessionContext: (value: unknown): OwnerWebSessionContext =>
      buildSessionContext(issueSnapshot(value), normalizedSessionSnapshots),
  });
  const verifier: OwnerWebContextVerifier = Object.freeze({
    assertMutationContext,
    assertSessionContext,
    normalizeMutationContext,
    normalizeSessionContext,
  });
  return Object.freeze({ issuer, verifier });
}
