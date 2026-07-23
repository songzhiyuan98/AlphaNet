// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FollowControl } from "./follow-control";

const ids = {
  actor: "10000000-0000-4000-8000-000000000001",
  content: "10000000-0000-4000-8000-000000000002",
  humanActor: "10000000-0000-4000-8000-000000000003",
} as const;
const timestamp = "2026-07-22T18:00:00.000Z";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function identitiesResponse() {
  return {
    identities: [
      {
        kind: "human",
        selection: {
          actor_kind: "human",
          actor_id: ids.humanActor,
        },
        profile: {
          actor_id: ids.humanActor,
          kind: "human",
          handle: "human-researcher",
          display_name: "Human Researcher",
          bio: null,
          status: "active",
          created_at: timestamp,
          updated_at: timestamp,
        },
      },
    ],
    request_id: "req-identities",
    schema_version: "1",
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FollowControl", () => {
  it.each([
    ["actor", ids.actor, "new_posts"],
    ["symbol", "MU", "new_posts"],
    ["topic", "semiconductors", "new_posts"],
    ["content", ids.content, "all_events"],
  ] as const)(
    "follows a %s target through the selected Human identity",
    async (targetType, targetId, expectedLevel) => {
      const user = userEvent.setup();
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(identitiesResponse()))
        .mockResolvedValueOnce(
          jsonResponse({
            decision: "allow",
            error: null,
            pending_action: null,
            request_id: "req-follow",
            result: {
              active: true,
              notification_level: expectedLevel,
              target_id: targetId,
              target_type: targetType,
              updated_at: timestamp,
            },
            schema_version: "1",
            status: "succeeded",
          }),
        );
      vi.stubGlobal("fetch", fetchMock);
      vi.stubGlobal("crypto", {
        randomUUID: () => "10000000-0000-4000-8000-000000000010",
      });

      render(
        <FollowControl loginHref="/login" targetId={targetId} targetType={targetType} />,
      );
      await user.click(screen.getByRole("button", { name: "关注" }));
      expect(
        await screen.findByRole("option", { name: /Human Researcher/u }),
      ).toBeTruthy();
      await user.click(screen.getByRole("button", { name: "确认关注" }));

      expect(await screen.findByText("已关注。")).toBeTruthy();
      expect(screen.getByRole("button", { name: "已关注" })).toBeTruthy();
      const [url, init] = fetchMock.mock.calls[1] ?? [];
      expect(url).toBe(
        `/v1/owner/social/follows/${encodeURIComponent(
          targetType,
        )}/${encodeURIComponent(targetId)}`,
      );
      if (typeof init?.body !== "string") throw new Error("Expected a JSON body");
      expect(JSON.parse(init.body)).toEqual({
        actor_selection: {
          actor_kind: "human",
          actor_id: ids.humanActor,
        },
        active: true,
        idempotency_key: "owner-web-follow-10000000-0000-4000-8000-000000000010",
        notification_level: expectedLevel,
      });
    },
  );
});
