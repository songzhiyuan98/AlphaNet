import {
  AdminTopicCommunityListRequestSchema,
  type AdminTopicCommunityListRequest,
} from "@alphanet/contracts";

function one(
  parameters: Record<string, string | readonly string[] | undefined>,
  name: string,
): string | undefined | null {
  const value = parameters[name];
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : null;
}

export function parseAdminCommunityQuery(
  parameters: Record<string, string | readonly string[] | undefined>,
): { ok: true; value: AdminTopicCommunityListRequest } | { ok: false } {
  const allowed = new Set(["cursor", "limit", "query", "states"]);
  if (Object.keys(parameters).some((key) => !allowed.has(key))) return { ok: false };
  const cursor = one(parameters, "cursor");
  const limit = one(parameters, "limit");
  const query = one(parameters, "query");
  const states = one(parameters, "states");
  if (cursor === null || limit === null || query === null || states === null) {
    return { ok: false };
  }
  if (limit !== undefined && !/^[1-9][0-9]*$/u.test(limit)) return { ok: false };
  const parsed = AdminTopicCommunityListRequestSchema.safeParse({
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit: Number(limit) }),
    ...(query === undefined || query.trim() === "" ? {} : { query }),
    ...(states === undefined ? {} : { states: states.split(",") }),
  });
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}
