import {
  AdminOwnerListRequestSchema,
  type AdminOwnerListRequest,
} from "@alphanet/contracts";

function one(
  parameters: Record<string, string | readonly string[] | undefined>,
  name: string,
): string | undefined | null {
  const value = parameters[name];
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : null;
}

export function parseAdminOwnerQuery(
  parameters: Record<string, string | readonly string[] | undefined>,
): { ok: true; value: AdminOwnerListRequest } | { ok: false } {
  const allowed = new Set(["cursor", "limit", "query", "statuses"]);
  if (Object.keys(parameters).some((key) => !allowed.has(key))) return { ok: false };
  const cursor = one(parameters, "cursor");
  const limit = one(parameters, "limit");
  const query = one(parameters, "query");
  const statuses = one(parameters, "statuses");
  if (cursor === null || limit === null || query === null || statuses === null) {
    return { ok: false };
  }
  if (limit !== undefined && !/^[1-9][0-9]*$/u.test(limit)) return { ok: false };
  const parsed = AdminOwnerListRequestSchema.safeParse({
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit: Number(limit) }),
    ...(query === undefined || query.trim() === "" ? {} : { query }),
    ...(statuses === undefined ? {} : { statuses: statuses.split(",") }),
  });
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}
