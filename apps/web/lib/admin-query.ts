import {
  AdminModerationCaseDetailRequestSchema,
  AdminModerationCaseListRequestSchema,
  type AdminModerationCaseDetailRequest,
  type AdminModerationCaseListRequest,
} from "@alphanet/contracts";

export type AdminRawSearchParams = Record<string, string | readonly string[] | undefined>;

export type AdminQueryResult<T> = { ok: true; value: T } | { ok: false };

const queueKeys = new Set([
  "content_id",
  "cursor",
  "limit",
  "priorities",
  "reasons",
  "statuses",
]);
const detailKeys = new Set([
  "action_cursor",
  "action_limit",
  "report_cursor",
  "report_limit",
]);

function hasOnlyKnownKeys(
  query: AdminRawSearchParams,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(query).every((key) => allowed.has(key));
}

function scalar(query: AdminRawSearchParams, name: string): string | undefined | null {
  const value = query[name];
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : null;
}

function positiveInteger(
  query: AdminRawSearchParams,
  name: string,
  fallback: number,
): number | null {
  const value = scalar(query, name);
  if (value === null) return null;
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function list(
  query: AdminRawSearchParams,
  name: string,
): readonly string[] | undefined | null {
  const raw = query[name];
  if (raw === undefined) return undefined;
  const values = (typeof raw === "string" ? [raw] : raw).flatMap((value) =>
    value.split(","),
  );
  if (values.length === 0 || values.some((value) => value.length === 0)) return null;
  return values;
}

export function parseAdminModerationQueueQuery(
  query: AdminRawSearchParams,
): AdminQueryResult<AdminModerationCaseListRequest> {
  if (!hasOnlyKnownKeys(query, queueKeys)) return { ok: false };
  const requestedStatuses = list(query, "statuses");
  const statuses = requestedStatuses ?? ["open", "reviewing"];
  const priorities = list(query, "priorities");
  const reasons = list(query, "reasons");
  const contentIdValue = scalar(query, "content_id");
  const contentId = contentIdValue === "" ? undefined : contentIdValue;
  const cursor = scalar(query, "cursor");
  const limit = positiveInteger(query, "limit", 20);
  if (
    requestedStatuses === null ||
    priorities === null ||
    reasons === null ||
    contentId === null ||
    cursor === null ||
    limit === null
  ) {
    return { ok: false };
  }
  const parsed = AdminModerationCaseListRequestSchema.safeParse({
    statuses,
    limit,
    ...(priorities === undefined ? {} : { priorities }),
    ...(reasons === undefined ? {} : { reasons }),
    ...(contentId === undefined ? {} : { content_id: contentId }),
    ...(cursor === undefined ? {} : { cursor }),
  });
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

export function parseAdminCaseDetailQuery(
  query: AdminRawSearchParams,
): AdminQueryResult<AdminModerationCaseDetailRequest> {
  if (!hasOnlyKnownKeys(query, detailKeys)) return { ok: false };
  const reportCursor = scalar(query, "report_cursor");
  const actionCursor = scalar(query, "action_cursor");
  const reportLimit = positiveInteger(query, "report_limit", 20);
  const actionLimit = positiveInteger(query, "action_limit", 20);
  if (
    reportCursor === null ||
    actionCursor === null ||
    reportLimit === null ||
    actionLimit === null
  ) {
    return { ok: false };
  }
  const parsed = AdminModerationCaseDetailRequestSchema.safeParse({
    report_limit: reportLimit,
    action_limit: actionLimit,
    ...(reportCursor === undefined ? {} : { report_cursor: reportCursor }),
    ...(actionCursor === undefined ? {} : { action_cursor: actionCursor }),
  });
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}
