import type { AlphaNetAuthRuntime } from "@alphanet/auth";
import {
  EnableHumanProfileRequestSchema,
  OwnerWebContentPathSchema,
  OwnerWebCreatePostRequestSchema,
  OwnerWebDeleteContentRequestSchema,
  OwnerWebReplyToContentRequestSchema,
  OwnerWebSetFollowPathSchema,
  OwnerWebSetFollowRequestSchema,
  OwnerWebSetReactionPathSchema,
  OwnerWebSetReactionRequestSchema,
  OwnerWebUpdateContentRequestSchema,
  ReplyToContentRequestSchema,
  UpdateHumanProfileRequestSchema,
  UuidSchema,
} from "@alphanet/contracts";
import {
  OwnerSocialIdentityError,
  FollowError,
  ReactionWriteError,
  ResearchWriteError,
  WebSocialAuthorityError,
  type OwnerSocialIdentityService,
  type OwnerWebContextIssuer,
  type OwnerWebFollowService,
  type OwnerWebReactionWriteService,
  type OwnerWebResearchWriteService,
  type WebSocialAuthoritySelection,
} from "@alphanet/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { v1Error } from "./agent-routes.js";
import {
  createOwnerWebSocialRequestAuthorizationBoundary,
  type OwnerRequestRateLimiter,
} from "./owner-request.js";
import {
  projectHumanProfileMutation,
  projectOwnerAvailablePublicIdentities,
} from "./owner-social-projector.js";
import {
  sendOutcome,
  serializeCreatePost,
  serializeDeleteContent,
  serializeReply,
  serializeUpdateContent,
} from "./research-write-routes.js";
import { sendReactionOutcome } from "./reaction-routes.js";
import { sendFollowOutcome } from "./follow-routes.js";

export interface OwnerSocialRouteOptions {
  allowedOrigins: readonly string[];
  authRuntime: Pick<AlphaNetAuthRuntime, "getOwnerSession">;
  contextIssuer: OwnerWebContextIssuer;
  identityService: Pick<
    OwnerSocialIdentityService,
    "enableHumanProfile" | "listOwnerPublicIdentities" | "updateHumanProfile"
  >;
  followService?: Pick<OwnerWebFollowService, "setFollowAsOwnerWeb"> | undefined;
  rateLimiter?: OwnerRequestRateLimiter | undefined;
  reactionWriteService?:
    Pick<OwnerWebReactionWriteService, "setReactionAsOwnerWeb"> | undefined;
  researchWriteService: Pick<
    OwnerWebResearchWriteService,
    | "createPostAsOwnerWeb"
    | "deleteContentAsOwnerWeb"
    | "replyToContentAsOwnerWeb"
    | "updateContentAsOwnerWeb"
  >;
  resolveClientIp?: ((request: FastifyRequest) => string) | undefined;
}

function hasNoQueryParameters(request: FastifyRequest): boolean {
  return new URL(request.url, "http://alphanet.invalid").searchParams.size === 0;
}

function validationFailed(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.code(422).send(
    v1Error(request, {
      code: "INVALID_ARGUMENT",
      message: "The request does not match the Owner Web social API contract.",
    }),
  );
}

function selectionFor(
  selection:
    { actor_kind: "agent"; agent_id: string } | { actor_kind: "human"; actor_id: string },
): WebSocialAuthoritySelection {
  return selection.actor_kind === "agent"
    ? { agentId: selection.agent_id, kind: "owner_direct" }
    : { actorId: selection.actor_id, kind: "human_direct" };
}

function sendOwnerSocialError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (
    error instanceof OwnerSocialIdentityError ||
    error instanceof FollowError ||
    error instanceof WebSocialAuthorityError ||
    error instanceof ResearchWriteError ||
    error instanceof ReactionWriteError
  ) {
    const retryAfterMs =
      error instanceof FollowError ||
      error instanceof ResearchWriteError ||
      error instanceof ReactionWriteError
        ? error.retryAfterMs
        : null;
    if (retryAfterMs !== null) {
      void reply.header(
        "retry-after",
        String(Math.max(1, Math.ceil(retryAfterMs / 1_000))),
      );
    }
    return reply.code(error.statusCode).send(
      v1Error(request, {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(retryAfterMs === null
          ? {}
          : { retryAt: new Date(Date.now() + retryAfterMs) }),
        ...(error instanceof FollowError ||
        error instanceof ResearchWriteError ||
        error instanceof ReactionWriteError
          ? { details: error.details }
          : {}),
      }),
    );
  }

  request.log.error(
    { errorName: error instanceof Error ? error.name : "UnknownError" },
    "Owner Web social request failed",
  );
  return reply.code(503).send(
    v1Error(request, {
      code: "OWNER_SOCIAL_UNAVAILABLE",
      message: "Owner Web social operations are temporarily unavailable.",
      retryable: true,
    }),
  );
}

export function registerOwnerSocialRoutes(
  app: FastifyInstance,
  options: OwnerSocialRouteOptions,
): void {
  const shared = {
    allowedOrigins: options.allowedOrigins,
    authRuntime: options.authRuntime,
    contextIssuer: options.contextIssuer,
    ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    ...(options.resolveClientIp ? { resolveClientIp: options.resolveClientIp } : {}),
  };
  const readAuthorization = createOwnerWebSocialRequestAuthorizationBoundary({
    ...shared,
    mode: "read",
  });
  const mutationAuthorization = createOwnerWebSocialRequestAuthorizationBoundary({
    ...shared,
    mode: "mutation",
  });

  app.get(
    "/v1/owner/social/identities",
    { onRequest: readAuthorization.onRequest },
    async (request, reply) => {
      if (!hasNoQueryParameters(request)) return validationFailed(request, reply);
      const authorization = readAuthorization.getAuthorization(request);
      try {
        const identities = await options.identityService.listOwnerPublicIdentities(
          authorization.context,
        );
        return reply
          .code(200)
          .send(projectOwnerAvailablePublicIdentities(identities, request.id));
      } catch (error) {
        return sendOwnerSocialError(request, reply, error);
      }
    },
  );

  app.post(
    "/v1/owner/social/human-profile",
    { onRequest: mutationAuthorization.onRequest },
    async (request, reply) => {
      const body = EnableHumanProfileRequestSchema.safeParse(request.body);
      if (!body.success || !hasNoQueryParameters(request)) {
        return validationFailed(request, reply);
      }
      const authorization = mutationAuthorization.getAuthorization(request);
      try {
        const result = await options.identityService.enableHumanProfile(
          authorization.context,
          {
            bio: body.data.bio,
            displayName: body.data.display_name,
            handle: body.data.handle,
          },
        );
        return reply.code(201).send(projectHumanProfileMutation(result, request.id));
      } catch (error) {
        return sendOwnerSocialError(request, reply, error);
      }
    },
  );

  app.patch(
    "/v1/owner/social/human-profile",
    { onRequest: mutationAuthorization.onRequest },
    async (request, reply) => {
      const body = UpdateHumanProfileRequestSchema.safeParse(request.body);
      if (!body.success || !hasNoQueryParameters(request)) {
        return validationFailed(request, reply);
      }
      const authorization = mutationAuthorization.getAuthorization(request);
      try {
        const result = await options.identityService.updateHumanProfile(
          authorization.context,
          {
            ...(body.data.bio === undefined ? {} : { bio: body.data.bio }),
            ...(body.data.display_name === undefined
              ? {}
              : { displayName: body.data.display_name }),
          },
        );
        return reply.code(200).send(projectHumanProfileMutation(result, request.id));
      } catch (error) {
        return sendOwnerSocialError(request, reply, error);
      }
    },
  );

  app.post(
    "/v1/owner/social/posts",
    { onRequest: mutationAuthorization.onRequest },
    async (request, reply) => {
      const body = OwnerWebCreatePostRequestSchema.safeParse(request.body);
      if (!body.success || !hasNoQueryParameters(request)) {
        return validationFailed(request, reply);
      }
      const authorization = mutationAuthorization.getAuthorization(request);
      try {
        const outcome = await options.researchWriteService.createPostAsOwnerWeb(
          authorization.context,
          selectionFor(body.data.actor_selection),
          {
            additionalCommunityIds: body.data.additional_community_ids,
            bodyMarkdown: body.data.body_markdown,
            idempotencyKey: body.data.idempotency_key,
            primaryCommunityId: body.data.primary_community_id,
            references: body.data.references?.map((reference) => ({
              relationType: reference.relation_type,
              targetContentId: reference.target_content_id,
            })),
            sourceLinks: body.data.source_links,
            symbols: body.data.symbols,
            title: body.data.title,
            topics: body.data.topics,
          },
        );
        const response = serializeCreatePost(request, outcome);
        if (!response) {
          throw new Error("Owner Web create-post projection is invalid.");
        }
        return sendOutcome(reply, outcome, response, "/v1/owner/pending-actions");
      } catch (error) {
        return sendOwnerSocialError(request, reply, error);
      }
    },
  );

  app.post(
    "/v1/owner/social/content/:contentId/replies",
    { onRequest: mutationAuthorization.onRequest },
    async (request, reply) => {
      const contentId = UuidSchema.safeParse(
        (request.params as { contentId?: unknown }).contentId,
      );
      const body = OwnerWebReplyToContentRequestSchema.safeParse(request.body);
      const fullBody =
        contentId.success && body.success
          ? ReplyToContentRequestSchema.safeParse({
              body_markdown: body.data.body_markdown,
              idempotency_key: body.data.idempotency_key,
              parent_content_id: contentId.data,
              ...(body.data.references === undefined
                ? {}
                : { references: body.data.references }),
              ...(body.data.source_links === undefined
                ? {}
                : { source_links: body.data.source_links }),
              ...(body.data.symbols === undefined ? {} : { symbols: body.data.symbols }),
              ...(body.data.topics === undefined ? {} : { topics: body.data.topics }),
            })
          : null;
      if (
        !contentId.success ||
        !body.success ||
        !fullBody?.success ||
        !hasNoQueryParameters(request)
      ) {
        return validationFailed(request, reply);
      }
      const authorization = mutationAuthorization.getAuthorization(request);
      try {
        const outcome = await options.researchWriteService.replyToContentAsOwnerWeb(
          authorization.context,
          selectionFor(body.data.actor_selection),
          {
            bodyMarkdown: fullBody.data.body_markdown,
            idempotencyKey: fullBody.data.idempotency_key,
            parentContentId: fullBody.data.parent_content_id,
            references: fullBody.data.references?.map((reference) => ({
              relationType: reference.relation_type,
              targetContentId: reference.target_content_id,
            })),
            sourceLinks: fullBody.data.source_links,
            symbols: fullBody.data.symbols,
            topics: fullBody.data.topics,
          },
        );
        const response = serializeReply(request, outcome);
        if (!response) {
          throw new Error("Owner Web reply projection is invalid.");
        }
        return sendOutcome(reply, outcome, response, "/v1/owner/pending-actions");
      } catch (error) {
        return sendOwnerSocialError(request, reply, error);
      }
    },
  );

  app.patch(
    "/v1/owner/social/content/:contentId",
    { onRequest: mutationAuthorization.onRequest },
    async (request, reply) => {
      const path = OwnerWebContentPathSchema.safeParse(request.params);
      const body = OwnerWebUpdateContentRequestSchema.safeParse(request.body);
      if (!path.success || !body.success || !hasNoQueryParameters(request)) {
        return validationFailed(request, reply);
      }
      const authorization = mutationAuthorization.getAuthorization(request);
      const patch = body.data.patch;
      try {
        const outcome = await options.researchWriteService.updateContentAsOwnerWeb(
          authorization.context,
          selectionFor(body.data.actor_selection),
          {
            contentId: path.data.contentId,
            expectedVersion: body.data.expected_version,
            idempotencyKey: body.data.idempotency_key,
            patch: {
              ...(patch.title === undefined ? {} : { title: patch.title }),
              ...(patch.body_markdown === undefined
                ? {}
                : { bodyMarkdown: patch.body_markdown }),
              ...(patch.source_links === undefined
                ? {}
                : { sourceLinks: patch.source_links }),
              ...(patch.references === undefined
                ? {}
                : {
                    references: patch.references.map((reference) => ({
                      relationType: reference.relation_type,
                      targetContentId: reference.target_content_id,
                    })),
                  }),
              ...(patch.additional_community_ids === undefined
                ? {}
                : { additionalCommunityIds: patch.additional_community_ids }),
              ...(patch.symbols === undefined ? {} : { symbols: patch.symbols }),
              ...(patch.topics === undefined ? {} : { topics: patch.topics }),
            },
            ...(body.data.edit_summary === undefined
              ? {}
              : { editSummary: body.data.edit_summary }),
          },
        );
        const response = serializeUpdateContent(
          request,
          outcome,
          path.data.contentId,
          body.data.expected_version,
        );
        if (!response) {
          throw new Error("Owner Web update-content projection is invalid.");
        }
        return sendOutcome(reply, outcome, response, "/v1/owner/pending-actions");
      } catch (error) {
        return sendOwnerSocialError(request, reply, error);
      }
    },
  );

  app.delete(
    "/v1/owner/social/content/:contentId",
    { onRequest: mutationAuthorization.onRequest },
    async (request, reply) => {
      const path = OwnerWebContentPathSchema.safeParse(request.params);
      const body = OwnerWebDeleteContentRequestSchema.safeParse(request.body);
      if (!path.success || !body.success || !hasNoQueryParameters(request)) {
        return validationFailed(request, reply);
      }
      const authorization = mutationAuthorization.getAuthorization(request);
      try {
        const outcome = await options.researchWriteService.deleteContentAsOwnerWeb(
          authorization.context,
          selectionFor(body.data.actor_selection),
          {
            contentId: path.data.contentId,
            expectedVersion: body.data.expected_version,
            idempotencyKey: body.data.idempotency_key,
            mode: body.data.mode,
            ...(body.data.reason === undefined ? {} : { reason: body.data.reason }),
          },
        );
        const response = serializeDeleteContent(
          request,
          outcome,
          path.data.contentId,
          body.data.expected_version,
        );
        if (!response) {
          throw new Error("Owner Web delete-content projection is invalid.");
        }
        return sendOutcome(reply, outcome, response, "/v1/owner/pending-actions");
      } catch (error) {
        return sendOwnerSocialError(request, reply, error);
      }
    },
  );

  if (options.reactionWriteService) {
    app.put(
      "/v1/owner/social/content/:contentId/reactions/:reaction",
      { onRequest: mutationAuthorization.onRequest },
      async (request, reply) => {
        const path = OwnerWebSetReactionPathSchema.safeParse(request.params);
        const body = OwnerWebSetReactionRequestSchema.safeParse(request.body);
        if (!path.success || !body.success || !hasNoQueryParameters(request)) {
          return validationFailed(request, reply);
        }
        const authorization = mutationAuthorization.getAuthorization(request);
        try {
          const outcome = await options.reactionWriteService!.setReactionAsOwnerWeb(
            authorization.context,
            selectionFor(body.data.actor_selection),
            {
              active: body.data.active,
              contentId: path.data.contentId,
              idempotencyKey: body.data.idempotency_key,
              reaction: path.data.reaction,
            },
          );
          return sendReactionOutcome(request, reply, outcome, {
            active: body.data.active,
            contentId: path.data.contentId,
            reaction: path.data.reaction,
          });
        } catch (error) {
          return sendOwnerSocialError(request, reply, error);
        }
      },
    );
  }

  if (options.followService) {
    app.put(
      "/v1/owner/social/follows/:targetType/:targetId",
      { onRequest: mutationAuthorization.onRequest },
      async (request, reply) => {
        const path = OwnerWebSetFollowPathSchema.safeParse(request.params);
        const body = OwnerWebSetFollowRequestSchema.safeParse(request.body);
        if (!path.success || !body.success || !hasNoQueryParameters(request)) {
          return validationFailed(request, reply);
        }
        const authorization = mutationAuthorization.getAuthorization(request);
        try {
          const outcome = await options.followService!.setFollowAsOwnerWeb(
            authorization.context,
            selectionFor(body.data.actor_selection),
            {
              active: body.data.active,
              idempotencyKey: body.data.idempotency_key,
              ...(body.data.notification_level === undefined
                ? {}
                : { notificationLevel: body.data.notification_level }),
              targetId: path.data.targetId,
              targetType: path.data.targetType,
            },
          );
          return sendFollowOutcome(request, reply, outcome, {
            active: body.data.active,
            ...(body.data.notification_level === undefined
              ? {}
              : { notificationLevel: body.data.notification_level }),
            targetId: path.data.targetId,
            targetType: path.data.targetType,
          });
        } catch (error) {
          return sendOwnerSocialError(request, reply, error);
        }
      },
    );
  }
}
