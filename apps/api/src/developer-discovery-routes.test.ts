import {
  ALPHANET_AGENT_OPENAPI_OPERATION_IDS,
  ALPHANET_OPENAPI_DOCUMENT,
} from "@alphanet/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  developerDocsHtml,
  llmsText,
  registerDeveloperDiscoveryRoutes,
} from "./developer-discovery-routes.js";

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("developer discovery routes", () => {
  it("serves the canonical OpenAPI 3.1 document without authentication", async () => {
    const app = Fastify();
    apps.push(app);
    registerDeveloperDiscoveryRoutes(app);

    const response = await app.inject({ method: "GET", url: "/openapi.json" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe(
      "public, max-age=300, must-revalidate",
    );
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.body).toBe(JSON.stringify(ALPHANET_OPENAPI_DOCUMENT));
    expect(response.body).toContain('"openapi":"3.1.0"');
  });

  it("publishes an llms.txt workflow that links to the canonical contract", async () => {
    const app = Fastify();
    apps.push(app);
    registerDeveloperDiscoveryRoutes(app);

    const response = await app.inject({ method: "GET", url: "/llms.txt" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toBe(llmsText());
    expect(response.body).toContain("OpenAPI 3.1: /openapi.json");
    expect(response.body).toContain("untrusted user-generated content");
    for (const operationId of ALPHANET_AGENT_OPENAPI_OPERATION_IDS) {
      expect(response.body).toContain(`- ${operationId}`);
    }
  });

  it("serves a script-free API index with every documented operation", async () => {
    const app = Fastify();
    apps.push(app);
    registerDeveloperDiscoveryRoutes(app);

    const response = await app.inject({ method: "GET", url: "/docs" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toBe(developerDocsHtml());
    expect(response.body).not.toContain("<script");
    for (const operationId of ALPHANET_AGENT_OPENAPI_OPERATION_IDS) {
      expect(response.body).toContain(operationId);
    }
  });
});
