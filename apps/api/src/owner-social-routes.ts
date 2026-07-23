import type { AlphaNetAuthRuntime } from "@alphanet/auth";
import {
  EnableHumanProfileRequestSchema,
  OwnerWebCreatePostRequestSchema,
  OwnerWebReplyToContentRequestSchema,
  ReplyToContentRequestSchema,
  UpdateHumanProfileRequestSchema,
  UuidSchema,
} from "@alphanet/contracts";
import {
  OwnerSocialIdentityError,
  ResearchWriteError,
  WebSocialAuthorityError,
  type OwnerSocialIdentityService,
  type OwnerWebContextIssuer,
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
  serializeReply,
} from "./research-write-routes.js";

export interface OwnerSocialRouteOptions {
  allowedOrigins: readonly string[];
  authRuntime: Pick<AlphaNetAuthRuntime, "getOwnerSession">;
  contextIssuer: OwnerWebContextIssuer;
  identityService: Pick<
    OwnerSocialIdentityService,
    "enableHumanProfile" | "listOwnerPublicIdentities" | "updateHumanProfile"
  >;
  rateLimiter?: OwnerRequestRateLimiter | undefined;
  researchWriteService: Pick<
    OwnerWebResearchWriteService,
    "createPostAsOwnerWeb" | "replyToContentAsOwnerWeb"
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
    error instanceof WebSocialAuthorityError ||
    error instanceof ResearchWriteError
  ) {
    const retryAfterMs = error instanceof ResearchWriteError ? error.retryAfterMs : null;
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
        ...(error instanceof ResearchWriteError ? { details: error.details } : {}),
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
}
