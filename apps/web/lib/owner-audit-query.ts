import {
  OwnerAuditActionListRequestSchema,
  OwnerAuditSearchListRequestSchema,
  type OwnerAuditActionListRequest,
  type OwnerAuditSearchListRequest,
} from "@alphanet/contracts";

export type OwnerAuditStream = "actions" | "search";

export interface OwnerAuditPageQuery {
  actionFilters: OwnerAuditActionListRequest;
  ok: true;
  searchFilters: OwnerAuditSearchListRequest;
  stream: OwnerAuditStream;
  values: Record<string, string>;
}

export interface InvalidOwnerAuditPageQuery {
  ok: false;
}

const commonNames = new Set([
  "agent_id",
  "credential_id",
  "cursor",
  "from",
  "limit",
  "outcome",
  "stream",
  "to",
]);
const actionNames = new Set([...commonNames, "action"]);
const searchNames = new Set([...commonNames, "surface"]);

function one(
  value: string | readonly string[] | undefined,
  options: { emptyIsMissing?: boolean } = {},
): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  if (value.length === 0) return options.emptyIsMissing ? undefined : null;
  return value;
}

function timestamp(value: string | undefined): string | undefined | null {
  if (value === undefined) return undefined;
  const matched = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(value);
  if (!matched) return null;
  const candidate = `${matched[1]}T${matched[2]}:${matched[3]}:${matched[4] ?? "00"}.000Z`;
  const parsed = new Date(candidate);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === candidate
    ? candidate
    : null;
}

function limit(value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function compact(
  values: Record<string, string | number | undefined>,
): Record<string, string | number> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string | number] => {
      return entry[1] !== undefined;
    }),
  );
}

export function parseOwnerAuditPageQuery(
  query: Record<string, string | readonly string[] | undefined>,
): OwnerAuditPageQuery | InvalidOwnerAuditPageQuery {
  const streamValue = one(query.stream);
  if (streamValue === null) return { ok: false };
  const stream: OwnerAuditStream =
    streamValue === undefined || streamValue === "actions"
      ? "actions"
      : streamValue === "search"
        ? "search"
        : "actions";
  if (
    streamValue !== undefined &&
    streamValue !== "actions" &&
    streamValue !== "search"
  ) {
    return { ok: false };
  }
  const allowed = stream === "actions" ? actionNames : searchNames;
  if (Object.keys(query).some((name) => !allowed.has(name))) return { ok: false };

  const values: Record<string, string> = {};
  for (const [name, raw] of Object.entries(query)) {
    const value = one(raw, { emptyIsMissing: name !== "stream" });
    if (value === null) return { ok: false };
    if (value !== undefined) values[name] = value;
  }

  const parsedLimit = limit(values.limit);
  const from = timestamp(values.from);
  const to = timestamp(values.to);
  if (parsedLimit === null || from === null || to === null) return { ok: false };

  const common = {
    agent_id: values.agent_id,
    credential_id: values.credential_id,
    cursor: values.cursor,
    from,
    limit: parsedLimit,
    outcome: values.outcome,
    to,
  };
  const action = OwnerAuditActionListRequestSchema.safeParse(
    compact({ ...common, action: values.action }),
  );
  const search = OwnerAuditSearchListRequestSchema.safeParse(
    compact({ ...common, surface: values.surface }),
  );
  if (
    (stream === "actions" && !action.success) ||
    (stream === "search" && !search.success)
  ) {
    return { ok: false };
  }

  return {
    actionFilters: action.success ? action.data : {},
    ok: true,
    searchFilters: search.success ? search.data : {},
    stream,
    values,
  };
}

export function ownerAuditHref(
  stream: OwnerAuditStream,
  values: Record<string, string>,
  cursor?: string,
): string {
  const parameters = new URLSearchParams();
  parameters.set("stream", stream);
  for (const name of [
    "agent_id",
    "credential_id",
    "action",
    "outcome",
    "surface",
    "from",
    "to",
    "limit",
  ]) {
    const value = values[name];
    if (value) parameters.set(name, value);
  }
  if (cursor) parameters.set("cursor", cursor);
  return `/settings/activity?${parameters.toString()}`;
}
