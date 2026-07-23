import type { AlphaNetAuthRuntime, OwnerSession } from "@alphanet/auth";
import { OwnerAccountDataExportSchema, V1ErrorResponseSchema } from "@alphanet/contracts";
import type { OwnerAccountExportService } from "@alphanet/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerOwnerAccountExportRoutes } from "./owner-account-export-routes.js";

const ids = {
  owner: "40000000-0000-4000-8000-000000000001",
  session: "60000000-0000-4000-8000-000000000001",
} as const;
const allowedOrigin = "https://app.alphanet.test";
const now = new Date("2026-07-23T10:00:00.000Z");
const freshCreatedAt = new Date("2026-07-23T09:55:00.000Z");
const apps: FastifyInstance[] = [];

function ownerSession(createdAt = freshCreatedAt): OwnerSession {
  return {
    owner: {
      email: "owner@alphanet.test",
      emailVerified: true,
      id: ids.owner,
      name: "Research Owner",
      status: "active",
    },
    session: {
      createdAt,
      expiresAt: new Date("2026-07-30T10:00:00.000Z"),
      id: ids.session,
    },
  };
}

function snapshot() {
  return {
    export_version: "owner-account-data-v1",
    generated_at: now.toISOString(),
    owner: {
      id: ids.owner,
      email: "owner@alphanet.test",
      email_verified_at: now.toISOString(),
      status: "active",
      restriction_reason_code: null,
      restricted_at: null,
      suspended_at: null,
      locale: "en",
      timezone: "UTC",
      base_active_agent_limit: 5,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      deleted_at: null,
    },
    human_profile: null,
    agents: [],
    content: [],
    interactions: {
      reactions: [],
      follows: [],
      notifications: [],
      reports: [],
    },
  };
}

function createApp(options?: {
  session?: OwnerSession | null;
  exportAccountData?: OwnerAccountExportService["exportAccountData"];
}) {
  const app = Fastify({ logger: false });
  const getOwnerSession = vi.fn<AlphaNetAuthRuntime["getOwnerSession"]>(() =>
    Promise.resolve(options && "session" in options ? options.session! : ownerSession()),
  );
  const exportAccountData = vi.fn<OwnerAccountExportService["exportAccountData"]>(
    options?.exportAccountData ?? (() => Promise.resolve(snapshot())),
  );
  registerOwnerAccountExportRoutes(app, {
    allowedOrigins: [allowedOrigin],
    authRuntime: { getOwnerSession },
    now: () => now,
    service: {
      checkReady: () => Promise.resolve(),
      exportAccountData,
    },
  });
  apps.push(app);
  return { app, exportAccountData };
}

function headers(origin = allowedOrigin) {
  return {
    cookie: "alphanet.session=opaque",
    origin,
    "sec-fetch-site": "same-origin",
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

describe("Owner account data export route", () => {
  it("downloads a contract-validated snapshot from a fresh session", async () => {
    const { app, exportAccountData } = createApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/owner/account-data-export",
      headers: headers(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store, max-age=0");
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="alphanet-account-data-2026-07-23.json"',
    );
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(OwnerAccountDataExportSchema.parse(response.json()).owner.id).toBe(ids.owner);
    expect(exportAccountData).toHaveBeenCalledOnce();
    const call = exportAccountData.mock.calls[0];
    expect(call?.[0]).toBe(ids.owner);
    expect(call?.[1]).toMatchObject({
      authenticatedAt: freshCreatedAt,
      authenticationAssurance: "fresh_owner_session",
    });
    expect(typeof call?.[1].requestId).toBe("string");
  });

  it("requires reauthentication before reading any export data", async () => {
    const { app, exportAccountData } = createApp({
      session: ownerSession(new Date("2026-07-23T09:49:59.999Z")),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/owner/account-data-export",
      headers: headers(),
    });

    expect(response.statusCode).toBe(403);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "OWNER_REAUTHENTICATION_REQUIRED",
    );
    expect(exportAccountData).not.toHaveBeenCalled();
  });

  it("rejects cross-origin and input-bearing requests", async () => {
    const crossOrigin = createApp();
    const denied = await crossOrigin.app.inject({
      method: "POST",
      url: "/v1/owner/account-data-export",
      headers: headers("https://attacker.invalid"),
    });
    expect(denied.statusCode).toBe(403);
    expect(crossOrigin.exportAccountData).not.toHaveBeenCalled();

    const input = createApp();
    const invalid = await input.app.inject({
      method: "POST",
      url: "/v1/owner/account-data-export?format=raw",
      headers: headers(),
    });
    expect(invalid.statusCode).toBe(422);
    expect(input.exportAccountData).not.toHaveBeenCalled();
  });

  it("fails closed when the service returns secret or malformed fields", async () => {
    const { app } = createApp({
      exportAccountData: () =>
        Promise.resolve({ ...snapshot(), session_token: "never-return" }),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/owner/account-data-export",
      headers: headers(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("never-return");
  });
});
