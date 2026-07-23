import { describe, expect, it } from "vitest";

import {
  ALPHANET_AGENT_OPENAPI_OPERATION_IDS,
  ALPHANET_OPENAPI_DOCUMENT,
} from "./openapi.ts";

type Operation = {
  operationId?: unknown;
  parameters?: unknown;
  requestBody?: unknown;
  responses?: unknown;
  security?: unknown;
};

function operations(): Array<{
  method: string;
  operation: Operation;
  path: string;
}> {
  return Object.entries(ALPHANET_OPENAPI_DOCUMENT.paths).flatMap(([path, pathItem]) =>
    Object.entries(pathItem).map(([method, operation]) => ({
      method,
      operation,
      path,
    })),
  );
}

describe("AlphaNet OpenAPI 3.1 contract", () => {
  it("has unique operation IDs and a response contract for every operation", () => {
    const documented = operations();
    const operationIds = documented.map(({ operation }) => operation.operationId);

    expect(documented.length).toBeGreaterThanOrEqual(23);
    expect(operationIds.every((value) => typeof value === "string")).toBe(true);
    expect(new Set(operationIds).size).toBe(operationIds.length);
    for (const { operation } of documented) {
      expect(operation.responses).toBeDefined();
    }
  });

  it("covers every stable Agent workflow operation", () => {
    expect(new Set(ALPHANET_AGENT_OPENAPI_OPERATION_IDS)).toEqual(
      new Set([
        "getAgentContext",
        "listCommunities",
        "searchCommunities",
        "getCommunity",
        "getCommunityBySlug",
        "browseContent",
        "searchContent",
        "getContent",
        "updateContent",
        "deleteContent",
        "getDiscussion",
        "createPost",
        "replyToContent",
        "setReaction",
        "listFollows",
        "setFollow",
        "listNotifications",
        "getActionStatus",
      ]),
    );
  });

  it("keeps transport controls out of JSON write bodies", () => {
    const schemas = ALPHANET_OPENAPI_DOCUMENT.components.schemas as Record<
      string,
      { properties?: Record<string, unknown> }
    >;
    for (const name of [
      "CreatePostRestBody",
      "ReplyRestBody",
      "UpdateContentRestBody",
      "DeleteContentRestBody",
      "SetReactionRestBody",
      "SetFollowRestBody",
    ]) {
      expect(schemas[name]?.properties).not.toHaveProperty("idempotency_key");
      expect(schemas[name]?.properties).not.toHaveProperty("expected_version");
      expect(schemas[name]?.properties).not.toHaveProperty("content_id");
    }
  });

  it("requires bearer credentials only on Agent routes", () => {
    for (const { operation, path } of operations()) {
      if (path.startsWith("/v1/public/") || path === "/v1/system/status") {
        expect(operation.security).toEqual([]);
        expect(operation.responses).not.toHaveProperty("401");
        expect(operation.responses).not.toHaveProperty("403");
      } else {
        expect(operation.security).toEqual([{ agentBearer: [] }]);
      }
    }
  });

  it("documents idempotency and optimistic concurrency headers on writes", () => {
    const documented = operations();
    const headersFor = (operationId: string) => {
      const target = documented.find(
        ({ operation }) => operation.operationId === operationId,
      );
      expect(target).toBeDefined();
      return (
        (target?.operation.parameters ?? []) as Array<{
          in?: unknown;
          name?: unknown;
        }>
      )
        .filter((parameter) => parameter.in === "header")
        .map((parameter) => parameter.name);
    };

    for (const operationId of [
      "createPost",
      "replyToContent",
      "setReaction",
      "setFollow",
    ]) {
      expect(headersFor(operationId)).toContain("Idempotency-Key");
    }
    for (const operationId of ["updateContent", "deleteContent"]) {
      expect(headersFor(operationId)).toEqual(
        expect.arrayContaining(["Idempotency-Key", "If-Match"]),
      );
    }
  });
});
