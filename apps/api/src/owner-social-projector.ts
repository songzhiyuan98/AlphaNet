import { isDeepStrictEqual } from "node:util";

import {
  OwnerAvailablePublicIdentitiesResponseSchema,
  WEB_SOCIAL_SCHEMA_VERSION,
  type OwnerAvailablePublicIdentitiesResponse,
  type OwnerAvailablePublicIdentity,
} from "@alphanet/contracts";
import type { OwnerPublicIdentityView } from "@alphanet/domain";

const INVALID_PROJECTION_MESSAGE = "The Owner public identity projection is invalid.";

function isoTimestamp(value: Date): string {
  let milliseconds: number;
  try {
    milliseconds = Date.prototype.getTime.call(value);
  } catch {
    throw new Error(INVALID_PROJECTION_MESSAGE);
  }
  if (!Number.isFinite(milliseconds)) {
    throw new Error(INVALID_PROJECTION_MESSAGE);
  }
  return new Date(milliseconds).toISOString();
}

function projectIdentity(
  identity: OwnerPublicIdentityView,
): OwnerAvailablePublicIdentity {
  if (identity.kind === "human") {
    return {
      kind: "human",
      selection: {
        actor_kind: "human",
        actor_id: identity.actorId,
      },
      profile: {
        actor_id: identity.actorId,
        kind: "human",
        handle: identity.handle,
        display_name: identity.displayName,
        bio: identity.bio,
        status: identity.status,
        created_at: isoTimestamp(identity.createdAt),
        updated_at: isoTimestamp(identity.updatedAt),
      },
    };
  }

  if (identity.kind === "agent") {
    return {
      kind: "agent",
      selection: {
        actor_kind: "agent",
        agent_id: identity.agentId,
      },
      profile: {
        id: identity.agentId,
        actor_id: identity.actorId,
        handle: identity.handle,
        display_name: identity.displayName,
        bio: identity.bio,
        discovery_tags: [...identity.discoveryTags],
        status: identity.status,
        created_at: isoTimestamp(identity.createdAt),
        activated_at: isoTimestamp(identity.joinedAt),
      },
    };
  }

  throw new Error(INVALID_PROJECTION_MESSAGE);
}

/**
 * The single allowlist boundary from Owner domain views to the public v1 Web
 * response. The final schema parse prevents domain drift from becoming an API
 * contract change.
 */
export function projectOwnerAvailablePublicIdentities(
  identities: readonly OwnerPublicIdentityView[],
  requestId: string,
): OwnerAvailablePublicIdentitiesResponse {
  const response = {
    schema_version: WEB_SOCIAL_SCHEMA_VERSION,
    request_id: requestId,
    identities: identities.map(projectIdentity),
  };

  const parsed = OwnerAvailablePublicIdentitiesResponseSchema.parse(response);
  if (!isDeepStrictEqual(parsed, response)) {
    throw new Error(INVALID_PROJECTION_MESSAGE);
  }
  return parsed;
}
