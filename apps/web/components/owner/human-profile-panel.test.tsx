// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HumanProfilePanel } from "./human-profile-panel";

const ids = {
  agent: "10000000-0000-4000-8000-000000000001",
  agentActor: "10000000-0000-4000-8000-000000000002",
  humanActor: "10000000-0000-4000-8000-000000000003",
} as const;

const timestamp = "2026-07-22T18:00:00.000Z";

function agentIdentity() {
  return {
    kind: "agent",
    selection: { actor_kind: "agent", agent_id: ids.agent },
    profile: {
      id: ids.agent,
      actor_id: ids.agentActor,
      handle: "risk-agent",
      display_name: "Risk Agent",
      bio: null,
      discovery_tags: [],
      status: "active",
      created_at: timestamp,
      activated_at: timestamp,
    },
  };
}

function humanIdentity(displayName = "Zhiyuan") {
  return {
    kind: "human",
    selection: { actor_kind: "human", actor_id: ids.humanActor },
    profile: {
      actor_id: ids.humanActor,
      kind: "human",
      handle: "zhiyuan-research",
      display_name: displayName,
      bio: "Independent market researcher.",
      status: "active",
      created_at: timestamp,
      updated_at: timestamp,
    },
  };
}

function identitiesResponse(identities: unknown[]) {
  return {
    identities,
    request_id: "req-identities",
    schema_version: "1",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("HumanProfilePanel", () => {
  it("enables an optional Human profile without changing Agent identities", async () => {
    const user = userEvent.setup();
    const human = humanIdentity();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(identitiesResponse([agentIdentity()])))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            changed: true,
            profile: human.profile,
            request_id: "req-enable-human",
            schema_version: "1",
          },
          201,
        ),
      )
      .mockResolvedValueOnce(jsonResponse(identitiesResponse([human, agentIdentity()])));
    vi.stubGlobal("fetch", fetchMock);

    render(<HumanProfilePanel />);
    const form = await screen.findByRole("form", { name: "管理 Human profile" });
    await user.type(within(form).getByLabelText(/公开 Handle/u), "Zhiyuan Research");
    await user.type(within(form).getByLabelText("公开名称"), "Zhiyuan");
    await user.type(
      within(form).getByLabelText("简介（可选）"),
      "Independent market researcher.",
    );
    await user.click(within(form).getByRole("button", { name: "启用 Human profile" }));

    expect(
      await screen.findByText("Human profile 已启用，可以代表自己参与社区。"),
    ).not.toBeNull();
    const [url, init] = fetchMock.mock.calls[1] ?? [];
    expect(url).toBe("/v1/owner/social/human-profile");
    expect(init?.method).toBe("POST");
    if (typeof init?.body !== "string") throw new Error("Expected a JSON body");
    expect(JSON.parse(init.body)).toEqual({
      handle: "zhiyuan-research",
      display_name: "Zhiyuan",
      bio: "Independent market researcher.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("updates the existing Human profile without offering a mutable handle", async () => {
    const user = userEvent.setup();
    const human = humanIdentity();
    const updated = humanIdentity("Zhiyuan Song");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(identitiesResponse([human, agentIdentity()])))
      .mockResolvedValueOnce(
        jsonResponse({
          changed: true,
          profile: updated.profile,
          request_id: "req-update-human",
          schema_version: "1",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(identitiesResponse([updated, agentIdentity()])),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<HumanProfilePanel />);
    const form = await screen.findByRole("form", { name: "管理 Human profile" });
    expect(within(form).queryByLabelText(/公开 Handle/u)).toBeNull();
    expect(screen.getByText("@zhiyuan-research")).not.toBeNull();
    const displayName = within(form).getByLabelText("公开名称");
    await user.clear(displayName);
    await user.type(displayName, "Zhiyuan Song");
    await user.click(within(form).getByRole("button", { name: "保存 Human profile" }));

    expect(await screen.findByText("Human profile 已更新。")).not.toBeNull();
    const [url, init] = fetchMock.mock.calls[1] ?? [];
    expect(url).toBe("/v1/owner/social/human-profile");
    expect(init?.method).toBe("PATCH");
    if (typeof init?.body !== "string") throw new Error("Expected a JSON body");
    expect(JSON.parse(init.body)).toEqual({
      display_name: "Zhiyuan Song",
      bio: "Independent market researcher.",
    });
  });
});
