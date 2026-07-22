import type { AlphaNetAuthRuntime, OwnerSession } from "@alphanet/auth";
import {
  OwnerContentReportCreateResponseSchema,
  V1ErrorResponseSchema,
} from "@alphanet/contracts";
import {
  ContentReportError,
  type ContentReportProjection,
  type ContentReportService,
} from "@alphanet/domain";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { registerOwnerReportRoutes } from "./owner-report-routes.js";

const ids = {
  actor: "11111111-1111-4111-8111-111111111111",
  case: "22222222-2222-4222-8222-222222222222",
  content: "33333333-3333-4333-8333-333333333333",
  owner: "44444444-4444-4444-8444-444444444444",
  report: "55555555-5555-4555-8555-555555555555",
  session: "66666666-6666-4666-8666-666666666666",
} as const;
const now = new Date("2026-07-21T18:00:00.000Z");
const ownerSession: OwnerSession = {
  owner: {
    email: "owner@example.com",
    emailVerified: true,
    id: ids.owner,
    name: "Owner",
    status: "active",
  },
  session: {
    createdAt: new Date("2026-07-21T17:55:00.000Z"),
    expiresAt: new Date("2026-07-28T17:55:00.000Z"),
    id: ids.session,
  },
};

function projection(
  overrides: Partial<ContentReportProjection> = {},
): ContentReportProjection {
  return {
    caseId: ids.case,
    contentId: ids.content,
    details: null,
    id: ids.report,
    reasonCode: "spam",
    reporterActorId: ids.actor,
    resolvedAt: null,
    status: "open",
    submittedAt: now,
    updatedAt: now,
    version: 1,
    ...overrides,
  };
}

function createApp(
  options: {
    result?: Awaited<ReturnType<ContentReportService["createReport"]>>;
    session?: OwnerSession | null;
    thrown?: Error;
  } = {},
) {
  const createReport = vi.fn<ContentReportService["createReport"]>(() => {
    if (options.thrown) return Promise.reject(options.thrown);
    return Promise.resolve(
      options.result ?? {
        created: true,
        deduplicated: false,
        replayed: false,
        report: projection(),
      },
    );
  });
  const getOwnerSession = vi.fn<AlphaNetAuthRuntime["getOwnerSession"]>(() =>
    Promise.resolve(options.session === undefined ? ownerSession : options.session),
  );
  const app = Fastify({ logger: false });
  registerOwnerReportRoutes(app, {
    allowedOrigins: ["http://localhost:3101"],
    authRuntime: { getOwnerSession },
    service: { createReport },
  });
  return { app, createReport, getOwnerSession };
}

const validRequest = {
  body: {
    reporter_actor_id: ids.actor,
    reason_code: "spam",
  },
  headers: {
    cookie: "owner_session=test",
    "idempotency-key": "report-request-01",
    origin: "http://localhost:3101",
    "sec-fetch-site": "same-origin",
  },
  method: "POST" as const,
  url: `/v1/owner/content/${ids.content}/reports`,
};

describe("Owner content-report route", () => {
  it("creates a report from the explicitly selected owned Agent", async () => {
    const { app, createReport } = createApp();
    const response = await app.inject(validRequest);

    expect(response.statusCode).toBe(201);
    expect(response.headers.location).toBeUndefined();
    expect(response.headers["cache-control"]).toBe("no-store, private");
    const parsed = OwnerContentReportCreateResponseSchema.parse(response.json());
    expect(parsed.created).toBe(true);
    expect(parsed.report).toMatchObject({
      case_id: ids.case,
      content_id: ids.content,
      report_id: ids.report,
      reporter_actor_id: ids.actor,
      status: "open",
    });
    expect(createReport).toHaveBeenCalledOnce();
    const call = createReport.mock.calls[0];
    expect(call?.[0]).toMatchObject({
      authenticationAssurance: "email_verified_owner_session",
      ownerId: ids.owner,
    });
    expect(typeof call?.[0].requestId).toBe("string");
    expect(call?.[1]).toEqual({
      contentId: ids.content,
      idempotencyKey: "report-request-01",
      reasonCode: "spam",
      reporterActorId: ids.actor,
    });
  });

  it("returns the existing report without manufacturing another queue signal", async () => {
    const { app } = createApp({
      result: {
        created: false,
        deduplicated: true,
        replayed: false,
        report: projection(),
      },
    });
    const response = await app.inject(validRequest);
    expect(response.statusCode).toBe(200);
    expect(OwnerContentReportCreateResponseSchema.parse(response.json()).created).toBe(
      false,
    );
  });

  it.each([
    [
      "missing idempotency",
      {
        headers: {
          cookie: validRequest.headers.cookie,
          origin: validRequest.headers.origin,
          "sec-fetch-site": validRequest.headers["sec-fetch-site"],
        },
      },
    ],
    [
      "merged idempotency",
      { headers: { ...validRequest.headers, "idempotency-key": "one,two" } },
    ],
    ["unknown body field", { body: { ...validRequest.body, owner_id: ids.owner } }],
    ["forged target", { body: { ...validRequest.body, content_id: ids.content } }],
    ["query parameters", { url: `${validRequest.url}?admin=true` }],
  ])("rejects %s before entering the domain", async (_label, override) => {
    const { app, createReport } = createApp();
    const response = await app.inject({ ...validRequest, ...override });
    expect(response.statusCode).toBe(422);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "INVALID_ARGUMENT",
    );
    expect(createReport).not.toHaveBeenCalled();
  });

  it("does not expose the route without an authenticated Owner session", async () => {
    const { app, createReport } = createApp({ session: null });
    const response = await app.inject(validRequest);
    expect(response.statusCode).toBe(401);
    expect(createReport).not.toHaveBeenCalled();
  });

  it("maps controlled self-report and quota failures", async () => {
    const selfReport = createApp({
      thrown: new ContentReportError(
        "SELF_REPORT_NOT_ALLOWED",
        "An Agent cannot report its own content.",
      ),
    });
    const selfResponse = await selfReport.app.inject(validRequest);
    expect(selfResponse.statusCode).toBe(409);
    expect(V1ErrorResponseSchema.parse(selfResponse.json()).error.code).toBe(
      "SELF_REPORT_NOT_ALLOWED",
    );

    const retryAt = new Date(Date.now() + 60_000);
    const limited = createApp({
      thrown: new ContentReportError(
        "REPORT_LIMIT_REACHED",
        "The reporting limit was reached.",
        { retryAt },
      ),
    });
    const limitedResponse = await limited.app.inject(validRequest);
    expect(limitedResponse.statusCode).toBe(429);
    expect(Number(limitedResponse.headers["retry-after"])).toBeGreaterThan(0);
    expect(V1ErrorResponseSchema.parse(limitedResponse.json()).error.retryable).toBe(
      true,
    );
  });

  it("fails closed when the service or public projection is unavailable", async () => {
    const unavailable = createApp({ thrown: new Error("database password=secret") });
    const unavailableResponse = await unavailable.app.inject(validRequest);
    expect(unavailableResponse.statusCode).toBe(503);
    expect(unavailableResponse.body).not.toContain("password");

    const invalid = createApp({
      result: {
        created: true,
        deduplicated: false,
        replayed: false,
        report: projection({ details: " " }),
      },
    });
    const invalidResponse = await invalid.app.inject(validRequest);
    expect(invalidResponse.statusCode).toBe(503);
    expect(V1ErrorResponseSchema.parse(invalidResponse.json()).error.code).toBe(
      "CONTENT_REPORTING_UNAVAILABLE",
    );
  });
});
