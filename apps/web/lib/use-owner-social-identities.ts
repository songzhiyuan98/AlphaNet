"use client";

import {
  OwnerAvailablePublicIdentitiesResponseSchema,
  type OwnerAvailablePublicIdentity,
  type WebActorSelection,
} from "@alphanet/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  friendlyOwnerApiError,
  isOwnerApiAuthenticationError,
  ownerApiRequest,
} from "./browser-owner-api";

export type OwnerSocialIdentityLoadState =
  "idle" | "loading" | "ready" | "unauthenticated" | "error";

function selectionKey(selection: WebActorSelection): string {
  return selection.actor_kind === "agent"
    ? `agent:${selection.agent_id}`
    : `human:${selection.actor_id}`;
}

export function ownerSocialIdentityLabel(identity: OwnerAvailablePublicIdentity): string {
  return `${identity.profile.display_name} · @${identity.profile.handle} · ${
    identity.kind === "agent" ? "Agent" : "Human"
  }`;
}

export function useOwnerSocialIdentities(enabled: boolean) {
  const [state, setState] = useState<OwnerSocialIdentityLoadState>("idle");
  const [identities, setIdentities] = useState<OwnerAvailablePublicIdentity[]>([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    setError(null);
    try {
      const response = await ownerApiRequest(
        "/v1/owner/social/identities",
        OwnerAvailablePublicIdentitiesResponseSchema,
      );
      setIdentities(response.identities);
      setSelectedKey((current) => {
        if (
          current &&
          response.identities.some(
            (identity) => selectionKey(identity.selection) === current,
          )
        ) {
          return current;
        }
        return response.identities[0]
          ? selectionKey(response.identities[0].selection)
          : "";
      });
      setState("ready");
    } catch (requestError) {
      if (isOwnerApiAuthenticationError(requestError)) {
        setState("unauthenticated");
        return;
      }
      setError(friendlyOwnerApiError(requestError));
      setState("error");
    }
  }, []);

  useEffect(() => {
    if (enabled && state === "idle") {
      void load();
    }
  }, [enabled, load, state]);

  const selectedIdentity = useMemo(
    () =>
      identities.find((identity) => selectionKey(identity.selection) === selectedKey) ??
      null,
    [identities, selectedKey],
  );

  return {
    error,
    identities,
    load,
    selectedIdentity,
    selectedKey,
    setSelectedKey,
    state,
  };
}
