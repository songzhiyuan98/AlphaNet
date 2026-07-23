// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContentReactionControl } from "./content-reaction-control";

const ids = {
  content: "10000000-0000-4000-8000-000000000001",
  humanActor: "10000000-0000-4000-8000-000000000002",
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
          bio: "Cross-validates market research.",
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

function reactionResponse(active: boolean) {
  return {
    decision: "allow",
    error: null,
    pending_action: null,
    request_id: active ? "req-reaction-add" : "req-reaction-remove",
    result: {
      content_id: ids.content,
      reaction_counts: {
        agree: 1,
        disagree: 0,
        helpful: active ? 3 : 2,
      },
      viewer_state: {
        following: false,
        reactions: active ? ["helpful"] : [],
      },
    },
    schema_version: "1",
    status: "succeeded",
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ContentReactionControl", () => {
  it("adds and removes a reaction through an explicitly selected Human identity", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(identitiesResponse()))
      .mockResolvedValueOnce(jsonResponse(reactionResponse(true)))
      .mockResolvedValueOnce(jsonResponse(reactionResponse(false)));
    const randomUUID = vi
      .fn<() => `${string}-${string}-${string}-${string}-${string}`>()
      .mockReturnValueOnce("10000000-0000-4000-8000-000000000010")
      .mockReturnValueOnce("10000000-0000-4000-8000-000000000011");
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID });

    render(
      <ContentReactionControl
        contentId={ids.content}
        initialCounts={{ agree: 1, disagree: 0, helpful: 2 }}
        loginHref="/login"
      />,
    );

    await user.click(screen.getByRole("button", { name: "参与 Reaction" }));
    expect(await screen.findByRole("option", { name: /Human Researcher/u })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /添加 Helpful/u }));

    expect(
      (await screen.findByRole("button", { name: /撤销 Helpful/u })).textContent,
    ).toContain("3");
    const [addUrl, addInit] = fetchMock.mock.calls[1] ?? [];
    expect(addUrl).toBe(`/v1/owner/social/content/${ids.content}/reactions/helpful`);
    if (typeof addInit?.body !== "string") throw new Error("Expected a JSON body");
    expect(JSON.parse(addInit.body)).toEqual({
      actor_selection: {
        actor_kind: "human",
        actor_id: ids.humanActor,
      },
      active: true,
      idempotency_key: "owner-web-reaction-10000000-0000-4000-8000-000000000010",
    });

    await user.click(screen.getByRole("button", { name: /撤销 Helpful/u }));
    expect(
      (await screen.findByRole("button", { name: /添加 Helpful/u })).textContent,
    ).toContain("2");
    const [, removeInit] = fetchMock.mock.calls[2] ?? [];
    if (typeof removeInit?.body !== "string") throw new Error("Expected a JSON body");
    expect(JSON.parse(removeInit.body)).toMatchObject({
      actor_selection: {
        actor_kind: "human",
        actor_id: ids.humanActor,
      },
      active: false,
    });
    expect(randomUUID).toHaveBeenCalledTimes(2);
  });
});
