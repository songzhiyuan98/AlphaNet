import type { AlphaNetAuthRuntime } from "@alphanet/auth";
import {
  ListNotificationsRequestSchema,
  ListNotificationsResponseSchema,
  MarkAllNotificationsReadRequestSchema,
  MarkAllNotificationsReadResponseSchema,
  MarkNotificationReadRequestSchema,
  MarkNotificationReadResponseSchema,
  type ListNotificationsResponse,
  type MarkAllNotificationsReadResponse,
  type MarkNotificationReadResponse,
  type NotificationListFilters,
  type NotificationProjection as ContractNotificationProjection,
} from "@alphanet/contracts";
import {
  NotificationError,
  type AgentConnectionService,
  type NotificationListInput,
  type NotificationListPage,
  type NotificationProjection,
  type NotificationService,
} from "@alphanet/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  createAgentRequestAuthorizationBoundary,
  type AgentRequestRateLimiter,
} from "./agent-request.js";
import { v1Error } from "./agent-routes.js";
import {
  createOwnerRequestAuthorizationBoundary,
  type OwnerRequestRateLimiter,
} from "./owner-request.js";

export interface AgentNotificationRouteOptions {
  agentConnectionService: Pick<AgentConnectionService, "authenticateStaticApiKey">;
  rateLimiter?: AgentRequestRateLimiter | undefined;
  resolveClientIp?: ((request: FastifyRequest) => string) | undefined;
  service: NotificationService;
}

export interface OwnerNotificationRouteOptions {
  allowedOrigins: readonly string[];
  authRuntime: Pick<AlphaNetAuthRuntime, "getOwnerSession">;
  rateLimiter?: OwnerRequestRateLimiter | undefined;
  resolveClientIp?: ((request: FastifyRequest) => string) | undefined;
  service: NotificationService;
}

const LIST_QUERY_NAMES = new Set([
  "types",
  "unread_only",
  "symbols",
  "community_ids",
  "following_only",
  "created_after",
  "created_before",
  "limit",
  "cursor",
  "poll_cursor",
]);

function oneQueryValue(parameters: URLSearchParams, name: string): string | undefined {
  const values = parameters.getAll(name);
  return values.length === 1 ? values[0] : undefined;
}

function commaSeparated(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const values = value.split(",");
  return values.length > 0 && values.every((entry) => entry.length > 0)
    ? values
    : undefined;
}

function booleanValue(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function parseListRequest(request: FastifyRequest): NotificationListInput | null {
  const parameters = new URL(request.url, "http://alphanet.invalid").searchParams;
  for (const name of parameters.keys()) {
    if (!LIST_QUERY_NAMES.has(name) || parameters.getAll(name).length !== 1) return null;
  }

  const rawTypes = oneQueryValue(parameters, "types");
  const types = commaSeparated(rawTypes);
  if (parameters.has("types") && types === undefined) return null;
  const rawSymbols = oneQueryValue(parameters, "symbols");
  const symbols = commaSeparated(rawSymbols);
  if (parameters.has("symbols") && symbols === undefined) return null;
  const rawCommunityIds = oneQueryValue(parameters, "community_ids");
  const communityIds = commaSeparated(rawCommunityIds);
  if (parameters.has("community_ids") && communityIds === undefined) return null;

  const rawUnreadOnly = oneQueryValue(parameters, "unread_only");
  const unreadOnly = booleanValue(rawUnreadOnly);
  if (parameters.has("unread_only") && unreadOnly === undefined) return null;
  const rawFollowingOnly = oneQueryValue(parameters, "following_only");
  const followingOnly = booleanValue(rawFollowingOnly);
  if (parameters.has("following_only") && followingOnly === undefined) return null;
  const rawLimit = oneQueryValue(parameters, "limit");
  if (rawLimit !== undefined && !/^[1-9][0-9]*$/u.test(rawLimit)) return null;

  const candidate = {
    ...(types === undefined ? {} : { types }),
    ...(unreadOnly === undefined ? {} : { unread_only: unreadOnly }),
    ...(symbols === undefined ? {} : { symbols }),
    ...(communityIds === undefined ? {} : { community_ids: communityIds }),
    ...(followingOnly === undefined ? {} : { following_only: followingOnly }),
    ...(parameters.has("created_after")
      ? { created_after: oneQueryValue(parameters, "created_after") }
      : {}),
    ...(parameters.has("created_before")
      ? { created_before: oneQueryValue(parameters, "created_before") }
      : {}),
    ...(rawLimit === undefined ? {} : { limit: Number(rawLimit) }),
    ...(parameters.has("cursor") ? { cursor: oneQueryValue(parameters, "cursor") } : {}),
    ...(parameters.has("poll_cursor")
      ? { poll_cursor: oneQueryValue(parameters, "poll_cursor") }
      : {}),
  };
  const parsed = ListNotificationsRequestSchema.safeParse(candidate);
  if (!parsed.success) return null;
  return {
    ...(parsed.data.types === undefined ? {} : { types: parsed.data.types }),
    ...(parsed.data.unread_only === undefined
      ? {}
      : { unreadOnly: parsed.data.unread_only }),
    ...(parsed.data.symbols === undefined ? {} : { symbols: parsed.data.symbols }),
    ...(parsed.data.community_ids === undefined
      ? {}
      : { communityIds: parsed.data.community_ids }),
    ...(parsed.data.following_only === undefined
      ? {}
      : { followingOnly: parsed.data.following_only }),
    ...(parsed.data.created_after === undefined
      ? {}
      : { createdAfter: parsed.data.created_after }),
    ...(parsed.data.created_before === undefined
      ? {}
      : { createdBefore: parsed.data.created_before }),
    ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
    ...("cursor" in parsed.data && parsed.data.cursor !== undefined
      ? { cursor: parsed.data.cursor }
      : {}),
    ...("poll_cursor" in parsed.data ? { pollCursor: parsed.data.poll_cursor } : {}),
  };
}

function serializeTriggerActor(notification: NotificationProjection) {
  const actor = notification.triggerActor;
  if (!actor) return null;
  return actor.kind === "agent"
    ? {
        actor_id: actor.actorId,
        kind: actor.kind,
        handle: actor.handle,
        ...(actor.agentId ? { agent_id: actor.agentId } : {}),
      }
    : {
        actor_id: actor.actorId,
        kind: actor.kind,
        handle: actor.handle,
      };
}

function serializeNotification(
  notification: NotificationProjection,
): ContractNotificationProjection {
  const common = {
    id: notification.id,
    recipient_actor_id: notification.recipientActorId,
    type: notification.type,
    trigger_actor: serializeTriggerActor(notification),
    object: {
      type: notification.object.type,
      id: notification.object.id,
    },
    context: notification.context,
    summary: notification.summary,
    stable_target: {
      resource_type: notification.stableTarget.resourceType,
      resource_id: notification.stableTarget.resourceId,
      web_path: notification.stableTarget.webPath,
    },
    version: notification.version,
    occurred_at: notification.occurredAt.toISOString(),
    created_at: notification.createdAt.toISOString(),
    updated_at: notification.updatedAt.toISOString(),
    read_at: notification.readAt?.toISOString() ?? null,
    dedupe_key: notification.dedupeKey,
    schema_version: notification.schemaVersion,
  };
  if (notification.type !== "reaction.changed") {
    return common as ContractNotificationProjection;
  }
  return {
    ...common,
    type: "reaction.changed",
    last_occurred_at: notification.lastOccurredAt!.toISOString(),
    distinct_actor_count: notification.distinctActorCount!,
    distinct_actor_counts_by_kind: notification.distinctActorCountsByKind!,
  };
}

function serializeFilters(page: NotificationListPage): NotificationListFilters {
  const filters = page.filters;
  return {
    ...(filters.types.length > 0 ? { types: filters.types } : {}),
    ...(filters.unreadOnly ? { unread_only: true } : {}),
    ...(filters.symbols.length > 0 ? { symbols: filters.symbols } : {}),
    ...(filters.communityIds.length > 0 ? { community_ids: filters.communityIds } : {}),
    ...(filters.followingOnly ? { following_only: true } : {}),
    ...(filters.createdAfter
      ? { created_after: filters.createdAfter.toISOString() }
      : {}),
    ...(filters.createdBefore
      ? { created_before: filters.createdBefore.toISOString() }
      : {}),
  };
}

function serializeListPage(
  request: FastifyRequest,
  page: NotificationListPage,
): ListNotificationsResponse | null {
  const candidate = {
    mode: page.mode,
    filters: serializeFilters(page),
    items: page.items.map(serializeNotification),
    page:
      page.page === null
        ? null
        : {
            next_cursor: page.page.nextCursor,
            has_more: page.page.hasMore,
            limit: page.page.limit,
          },
    poll: {
      next_cursor: page.poll.nextCursor,
      has_more: page.poll.hasMore,
    },
    ordering: {
      snapshot_id: page.ordering.snapshotId,
      ordering_version: page.ordering.orderingVersion,
      as_of: page.ordering.asOf.toISOString(),
    },
    request_id: request.id,
    schema_version: "1",
  };
  const parsed = ListNotificationsResponseSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function serializeMarkOne(
  request: FastifyRequest,
  result: Awaited<ReturnType<NotificationService["markOwnerAgentNotificationRead"]>>,
): MarkNotificationReadResponse | null {
  const parsed = MarkNotificationReadResponseSchema.safeParse({
    changed: result.changed,
    notification: serializeNotification(result.notification),
    unread_count: result.unreadCount,
    request_id: request.id,
    schema_version: "1",
  });
  return parsed.success ? parsed.data : null;
}

function serializeMarkAll(
  request: FastifyRequest,
  result: Awaited<ReturnType<NotificationService["markAllOwnerAgentNotificationsRead"]>>,
): MarkAllNotificationsReadResponse | null {
  const parsed = MarkAllNotificationsReadResponseSchema.safeParse({
    read_at: result.readAt.toISOString(),
    marked_count: result.markedCount,
    unread_count: result.unreadCount,
    request_id: request.id,
    schema_version: "1",
  });
  return parsed.success ? parsed.data : null;
}

function validationFailed(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.code(422).send(
    v1Error(request, {
      code: "INVALID_ARGUMENT",
      message: "The request does not match the Notifications v1 contract.",
    }),
  );
}

function sendNotificationError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (error instanceof NotificationError) {
    return reply.code(error.statusCode).send(
      v1Error(request, {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      }),
    );
  }
  request.log.error(
    { errorName: error instanceof Error ? error.name : "UnknownError" },
    "Notification request failed",
  );
  return reply.code(503).send(
    v1Error(request, {
      code: "NOTIFICATION_NOT_READY",
      message: "The Notification service is temporarily unavailable.",
      retryable: true,
    }),
  );
}

function ownerAgentId(request: FastifyRequest): string | null {
  const value = (request.params as { agentId?: unknown }).agentId;
  return typeof value === "string" ? value : null;
}

function notificationId(request: FastifyRequest): string | null {
  const value = (request.params as { notificationId?: unknown }).notificationId;
  const parsed = MarkNotificationReadRequestSchema.safeParse({ notification_id: value });
  return parsed.success ? parsed.data.notification_id : null;
}

function hasNoQueryParameters(request: FastifyRequest): boolean {
  return new URL(request.url, "http://alphanet.invalid").searchParams.size === 0;
}

export function registerAgentNotificationRoutes(
  app: FastifyInstance,
  options: AgentNotificationRouteOptions,
): void {
  const authorization = createAgentRequestAuthorizationBoundary({
    operation: "list_notifications",
    service: options.agentConnectionService,
    ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    ...(options.resolveClientIp ? { resolveClientIp: options.resolveClientIp } : {}),
  });

  app.get(
    "/v1/notifications",
    {
      onRequest: async (request, reply) => {
        void reply.header("cache-control", "no-store, private");
        void reply.header("pragma", "no-cache");
        return authorization.onRequest(request, reply);
      },
    },
    async (request, reply) => {
      const input = parseListRequest(request);
      if (!input) return validationFailed(request, reply);
      try {
        const page = await options.service.listAgentNotifications(
          authorization.getAuthorization(request).context,
          input,
        );
        const response = serializeListPage(request, page);
        if (!response) throw new Error("Notification list response contract failed");
        return response;
      } catch (error) {
        return sendNotificationError(request, reply, error);
      }
    },
  );
}

export function registerOwnerNotificationRoutes(
  app: FastifyInstance,
  options: OwnerNotificationRouteOptions,
): void {
  const readAuthorization = createOwnerRequestAuthorizationBoundary({
    allowedOrigins: options.allowedOrigins,
    authRuntime: options.authRuntime,
    mode: "read",
    ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    ...(options.resolveClientIp ? { resolveClientIp: options.resolveClientIp } : {}),
  });
  const mutationAuthorization = createOwnerRequestAuthorizationBoundary({
    allowedOrigins: options.allowedOrigins,
    authRuntime: options.authRuntime,
    mode: "mutation",
    ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    ...(options.resolveClientIp ? { resolveClientIp: options.resolveClientIp } : {}),
  });

  app.get(
    "/v1/owner/agents/:agentId/notifications",
    { onRequest: readAuthorization.onRequest },
    async (request, reply) => {
      const agentId = ownerAgentId(request);
      const input = parseListRequest(request);
      if (!agentId || !input) return validationFailed(request, reply);
      try {
        const page = await options.service.listOwnerAgentNotifications(
          readAuthorization.getAuthorization(request).owner.id,
          agentId,
          input,
        );
        const response = serializeListPage(request, page);
        if (!response) throw new Error("Owner Notification list contract failed");
        return response;
      } catch (error) {
        return sendNotificationError(request, reply, error);
      }
    },
  );

  app.put(
    "/v1/owner/agents/:agentId/notifications/:notificationId/read",
    { onRequest: mutationAuthorization.onRequest },
    async (request, reply) => {
      const agentId = ownerAgentId(request);
      const id = notificationId(request);
      if (!agentId || !id || !hasNoQueryParameters(request)) {
        return validationFailed(request, reply);
      }
      if (
        request.body !== undefined &&
        !MarkAllNotificationsReadRequestSchema.safeParse(request.body).success
      ) {
        return validationFailed(request, reply);
      }
      try {
        const result = await options.service.markOwnerAgentNotificationRead(
          mutationAuthorization.getAuthorization(request).owner.id,
          agentId,
          id,
        );
        const response = serializeMarkOne(request, result);
        if (!response) throw new Error("Mark Notification response contract failed");
        return response;
      } catch (error) {
        return sendNotificationError(request, reply, error);
      }
    },
  );

  app.post(
    "/v1/owner/agents/:agentId/notifications/read-all",
    { onRequest: mutationAuthorization.onRequest },
    async (request, reply) => {
      const agentId = ownerAgentId(request);
      const parsedBody = MarkAllNotificationsReadRequestSchema.safeParse(
        request.body ?? {},
      );
      if (!agentId || !parsedBody.success || !hasNoQueryParameters(request)) {
        return validationFailed(request, reply);
      }
      try {
        const result = await options.service.markAllOwnerAgentNotificationsRead(
          mutationAuthorization.getAuthorization(request).owner.id,
          agentId,
        );
        const response = serializeMarkAll(request, result);
        if (!response) throw new Error("Mark all Notifications response contract failed");
        return response;
      } catch (error) {
        return sendNotificationError(request, reply, error);
      }
    },
  );
}
