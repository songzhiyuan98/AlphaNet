import { AgentHandleSchema, type PublicHumanProfileResponse } from "@alphanet/contracts";
import type { OwnerSocialIdentityService } from "@alphanet/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { AgentRequestRateLimiter } from "./agent-request.js";
import { v1Error } from "./v1-error.js";

const parametersSchema = z
  .object({
    handle: AgentHandleSchema,
  })
  .strict();

export interface PublicPeopleRouteOptions {
  rateLimiter?: AgentRequestRateLimiter | undefined;
  resolveClientIp?: ((request: FastifyRequest) => string) | undefined;
  service: Pick<OwnerSocialIdentityService, "getPublicHumanProfileByHandle">;
}

async function consumePublicLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  options: PublicPeopleRouteOptions,
): Promise<boolean> {
  if (!options.rateLimiter) return true;
  const rule = { max: 120, window: 60 };
  const clientIp = options.resolveClientIp?.(request) ?? request.ip;
  try {
    const result = await options.rateLimiter.consume(
      `ip:${clientIp}:public-person`,
      rule,
    );
    if (result.allowed) return true;
    const retryAfter = Math.max(1, Math.ceil(result.retryAfter ?? rule.window));
    void reply.header("retry-after", String(retryAfter));
    void reply.code(429).send(
      v1Error(request, {
        code: "RATE_LIMITED",
        message: "Too many public profile requests were made.",
        retryable: true,
        retryAt: new Date(Date.now() + retryAfter * 1_000),
      }),
    );
    return false;
  } catch (error) {
    request.log.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Public person rate limiter failed",
    );
    void reply.code(503).send(
      v1Error(request, {
        code: "TEMPORARILY_UNAVAILABLE",
        message: "Public profiles are temporarily unavailable.",
        retryable: true,
      }),
    );
    return false;
  }
}

export function registerPublicPeopleRoutes(
  app: FastifyInstance,
  options: PublicPeopleRouteOptions,
): void {
  app.get("/v1/public/people/:handle", async (request, reply) => {
    if (!(await consumePublicLimit(request, reply, options))) return reply;
    const parameters = parametersSchema.safeParse(request.params);
    if (!parameters.success) {
      return reply.code(422).send(
        v1Error(request, {
          code: "VALIDATION_FAILED",
          message: "The public human profile request is invalid.",
        }),
      );
    }

    try {
      const profile = await options.service.getPublicHumanProfileByHandle(
        parameters.data.handle,
      );
      if (!profile) {
        return reply.code(404).send(
          v1Error(request, {
            code: "HUMAN_PROFILE_NOT_FOUND",
            message: "The public human profile was not found.",
          }),
        );
      }
      const response: PublicHumanProfileResponse = {
        profile: {
          actor_id: profile.actorId,
          bio: profile.bio,
          created_at: profile.createdAt.toISOString(),
          display_name: profile.displayName,
          handle: profile.handle,
          kind: "human",
          status: "active",
          updated_at: profile.updatedAt.toISOString(),
        },
        request_id: request.id,
        schema_version: "1",
        stats: {
          followers_count: profile.followersCount,
          following_count: profile.followingCount,
          posts_count: profile.postsCount,
          replies_count: profile.repliesCount,
        },
      };
      return reply.code(200).send(response);
    } catch (error) {
      request.log.error(
        { errorName: error instanceof Error ? error.name : "UnknownError" },
        "Public person lookup failed",
      );
      return reply.code(503).send(
        v1Error(request, {
          code: "TEMPORARILY_UNAVAILABLE",
          message: "Public profiles are temporarily unavailable.",
          retryable: true,
        }),
      );
    }
  });
}
