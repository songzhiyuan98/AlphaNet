import { describe, expect, it } from "vitest";

import {
  createOwnerWebContextAuthority,
  OwnerWebSessionContextError,
  type OwnerWebContextAuthority,
  type OwnerWebMutationContext,
  type OwnerWebSessionContext,
} from "./owner-web-session-context.js";

const ownerId = "10000000-0000-4000-8000-000000000001";
const victimOwnerId = "10000000-0000-4000-8000-000000000099";
const sessionId = "20000000-0000-4000-8000-000000000001";
const authenticatedAt = new Date("2026-07-22T20:00:00.000Z");
const databaseCheckedAt = new Date("2026-07-22T20:00:01.000Z");
const authority: OwnerWebContextAuthority = createOwnerWebContextAuthority();

function sessionFacts(overrides: Record<string, unknown> = {}): unknown {
  return {
    ownerId,
    sessionId,
    requestId: "req-owner-web-context",
    authenticatedAt,
    authenticationAssurance: "owner_session",
    ...overrides,
  };
}

function issuedSession(overrides: Record<string, unknown> = {}): OwnerWebSessionContext {
  return authority.issuer.issueSessionContext(sessionFacts(overrides));
}

function issuedMutation(
  overrides: Record<string, unknown> = {},
): OwnerWebMutationContext {
  return authority.issuer.issueMutationContext(sessionFacts(overrides));
}

function capturedError(callback: () => unknown): OwnerWebSessionContextError {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(OwnerWebSessionContextError);
    return error as OwnerWebSessionContextError;
  }
  throw new Error("Expected OwnerWebSessionContextError");
}

describe("Owner Web context issuer", () => {
  it("separates issuance from verification capabilities", () => {
    expect(Object.keys(authority.issuer).sort()).toEqual([
      "issueMutationContext",
      "issueSessionContext",
    ]);
    expect(Object.keys(authority.verifier).sort()).toEqual([
      "assertMutationContext",
      "assertSessionContext",
      "normalizeMutationContext",
      "normalizeSessionContext",
    ]);
  });

  it("issues a frozen, detached context from exact trusted session facts", () => {
    const sourceTimestamp = new Date(authenticatedAt.valueOf());
    const issued = authority.issuer.issueSessionContext(
      sessionFacts({ authenticatedAt: sourceTimestamp }),
    );

    expect(issued).toEqual({
      ownerId,
      sessionId,
      requestId: "req-owner-web-context",
      authenticatedAt,
      authenticationAssurance: "owner_session",
    });
    expect(Object.isFrozen(issued)).toBe(true);
    expect(issued.authenticatedAt).not.toBe(sourceTimestamp);

    sourceTimestamp.setTime(0);
    const returnedTimestamp = issued.authenticatedAt;
    returnedTimestamp.setTime(0);
    expect(issued.authenticatedAt.toISOString()).toBe("2026-07-22T20:00:00.000Z");
  });

  it("issues a fresh session without trusting extra identity or secret fields", () => {
    expect(
      authority.issuer.issueSessionContext(
        sessionFacts({ authenticationAssurance: "fresh_owner_session" }),
      ),
    ).toMatchObject({ authenticationAssurance: "fresh_owner_session" });

    for (const field of ["email", "cookie", "token", "csrfValidated"]) {
      expect(() =>
        authority.issuer.issueSessionContext(
          sessionFacts({ [field]: "must-not-be-accepted" }),
        ),
      ).toThrow(OwnerWebSessionContextError);
    }
  });

  it.each([
    ["missing owner", { ownerId: undefined }],
    ["invalid owner", { ownerId: "not-a-uuid" }],
    [
      "non-canonical owner",
      { ownerId: "a0000000-0000-4000-8000-000000000001".toUpperCase() },
    ],
    ["missing session", { sessionId: undefined }],
    ["invalid session", { sessionId: "not-a-uuid" }],
    ["blank request", { requestId: "" }],
    ["padded request", { requestId: " request " }],
    ["oversized request", { requestId: "r".repeat(201) }],
    ["NUL request", { requestId: "request\0id" }],
    ["string timestamp", { authenticatedAt: authenticatedAt.toISOString() }],
    ["invalid Date", { authenticatedAt: new Date(Number.NaN) }],
    ["unknown assurance", { authenticationAssurance: "password_only" }],
  ])("rejects %s", (_label, override) => {
    expect(() => authority.issuer.issueSessionContext(sessionFacts(override))).toThrow(
      OwnerWebSessionContextError,
    );
  });

  it("rejects symbol, hidden, and accessor-backed facts without invoking accessors", () => {
    const symbolExtra = sessionFacts() as Record<PropertyKey, unknown>;
    symbolExtra[Symbol("token")] = "private-token";
    expect(() => authority.issuer.issueSessionContext(symbolExtra)).toThrow(
      OwnerWebSessionContextError,
    );

    const hiddenExtra = sessionFacts() as Record<string, unknown>;
    Object.defineProperty(hiddenExtra, "cookie", {
      enumerable: false,
      value: "private-cookie",
    });
    expect(() => authority.issuer.issueSessionContext(hiddenExtra)).toThrow(
      OwnerWebSessionContextError,
    );

    let getterInvoked = false;
    const accessor = sessionFacts() as Record<string, unknown>;
    Object.defineProperty(accessor, "ownerId", {
      enumerable: true,
      get() {
        getterInvoked = true;
        return ownerId;
      },
    });
    expect(() => authority.issuer.issueSessionContext(accessor)).toThrow(
      OwnerWebSessionContextError,
    );
    expect(getterInvoked).toBe(false);
  });
});

describe("normalizeOwnerWebSessionContext", () => {
  it("accepts only boundary-issued contexts and safely reissues the detached view", () => {
    const first = issuedSession();
    const second = authority.verifier.normalizeSessionContext(first, databaseCheckedAt);

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(Object.isFrozen(second)).toBe(true);
    const firstTimestamp = first.authenticatedAt;
    const secondTimestamp = second.authenticatedAt;
    firstTimestamp.setTime(0);
    secondTimestamp.setTime(0);
    expect(first.authenticatedAt.toISOString()).toBe("2026-07-22T20:00:00.000Z");
    expect(second.authenticatedAt.toISOString()).toBe("2026-07-22T20:00:00.000Z");
  });

  it("rejects raw victim identity/session objects and structurally identical clones", () => {
    const rawVictim = sessionFacts({ ownerId: victimOwnerId });
    expect(() =>
      authority.verifier.normalizeSessionContext(rawVictim, databaseCheckedAt),
    ).toThrow(OwnerWebSessionContextError);

    const issued = issuedSession();
    expect(() =>
      authority.verifier.normalizeSessionContext({ ...issued }, databaseCheckedAt),
    ).toThrow(OwnerWebSessionContextError);
    expect(() =>
      authority.verifier.normalizeSessionContext(
        { ...issued, ownerId: victimOwnerId },
        databaseCheckedAt,
      ),
    ).toThrow(OwnerWebSessionContextError);
  });

  it("rechecks the database authority time for every branded context", () => {
    const error = capturedError(() =>
      authority.verifier.normalizeSessionContext(
        issuedSession(),
        new Date(authenticatedAt.valueOf() - 1),
      ),
    );
    expect(error).toMatchObject({
      code: "OWNER_WEB_AUTHENTICATION_TIME_INVALID",
      retryable: false,
      statusCode: 401,
    });
  });

  it.each([
    new Date(Number.NaN),
    "2026-07-22" as unknown as Date,
    null as unknown as Date,
  ])("fails closed for an invalid database authority time", (candidate) => {
    const error = capturedError(() =>
      authority.verifier.normalizeSessionContext(issuedSession(), candidate),
    );
    expect(error).toMatchObject({
      code: "INVALID_DATABASE_CHECKED_AT",
      retryable: false,
      statusCode: 500,
    });
  });
});

describe("Owner Web mutation issuance", () => {
  it("issues mutation authority directly from trusted server session facts", () => {
    const mutation = issuedMutation();
    const normalized = authority.verifier.normalizeMutationContext(
      mutation,
      databaseCheckedAt,
    );

    expect(normalized).toMatchObject({ ownerId, sessionId, csrfValidated: true });
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(
      authority.verifier.normalizeSessionContext(mutation, databaseCheckedAt),
    ).toMatchObject({ ownerId, sessionId });
  });

  it("does not let a branded read context or forged CSRF fact become mutation authority", () => {
    const readContext = issuedSession();
    const forged = { ...readContext, csrfValidated: true };

    expect(() =>
      authority.issuer.issueMutationContext(
        readContext as unknown as Record<string, unknown>,
      ),
    ).toThrow(OwnerWebSessionContextError);
    expect(() =>
      authority.verifier.normalizeMutationContext(forged, databaseCheckedAt),
    ).toThrow(OwnerWebSessionContextError);
    expect(() =>
      authority.verifier.normalizeMutationContext(readContext, databaseCheckedAt),
    ).toThrow(
      expect.objectContaining({ code: "OWNER_WEB_CSRF_REQUIRED", statusCode: 403 }),
    );
  });

  it("rejects a fully forged raw mutation context, including a victim Owner ID", () => {
    const forged = {
      ...(sessionFacts({ ownerId: victimOwnerId }) as Record<string, unknown>),
      csrfValidated: true,
    };
    const error = capturedError(() =>
      authority.verifier.normalizeMutationContext(forged, databaseCheckedAt),
    );
    expect(error).toMatchObject({
      code: "INVALID_OWNER_WEB_SESSION_CONTEXT",
      statusCode: 400,
    });
  });

  it("rechecks database time after mutation issuance", () => {
    const error = capturedError(() =>
      authority.verifier.normalizeMutationContext(
        issuedMutation(),
        new Date(authenticatedAt.valueOf() - 1),
      ),
    );
    expect(error.code).toBe("OWNER_WEB_AUTHENTICATION_TIME_INVALID");
  });

  it("rejects contexts issued by another authority instance", () => {
    const foreignAuthority = createOwnerWebContextAuthority();
    const foreignSession = foreignAuthority.issuer.issueSessionContext(sessionFacts());
    const foreignMutation = foreignAuthority.issuer.issueMutationContext(sessionFacts());

    expect(() =>
      authority.verifier.normalizeSessionContext(foreignSession, databaseCheckedAt),
    ).toThrow(expect.objectContaining({ code: "INVALID_OWNER_WEB_SESSION_CONTEXT" }));
    expect(() =>
      authority.verifier.normalizeMutationContext(foreignMutation, databaseCheckedAt),
    ).toThrow(expect.objectContaining({ code: "INVALID_OWNER_WEB_SESSION_CONTEXT" }));
  });
});

describe("Owner Web context assertions", () => {
  it("narrows boundary-issued session and mutation values", () => {
    const session: unknown = issuedSession();
    authority.verifier.assertSessionContext(session, databaseCheckedAt);
    const typedSession: OwnerWebSessionContext = session;
    expect(typedSession.ownerId).toBe(ownerId);

    const mutation: unknown = issuedMutation();
    authority.verifier.assertMutationContext(mutation, databaseCheckedAt);
    const typedMutation: OwnerWebMutationContext = mutation;
    expect(typedMutation.csrfValidated).toBe(true);
  });

  it("keeps stable errors free of rejected secret values", () => {
    const secret = "aln_v1_private-session-cookie-token";
    const error = capturedError(() =>
      authority.verifier.normalizeSessionContext(
        { ...(sessionFacts() as object), token: secret },
        databaseCheckedAt,
      ),
    );
    expect(error).toMatchObject({
      code: "INVALID_OWNER_WEB_SESSION_CONTEXT",
      retryable: false,
      statusCode: 400,
    });
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });
});
