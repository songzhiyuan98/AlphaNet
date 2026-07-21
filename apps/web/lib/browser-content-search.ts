import {
  SearchContentRequestSchema,
  SearchContentResponseSchema,
  V1ErrorResponseSchema,
  type SearchContentRequest,
  type SearchContentResponse,
  type V1ErrorResponse,
} from "@alphanet/contracts";

const PUBLIC_CONTENT_SEARCH_PATH = "/v1/public/content/search";
const BROWSER_SEARCH_TIMEOUT_MILLISECONDS = 15_000;

export type BrowserContentSearchResult =
  | { kind: "invalid" }
  | { kind: "success"; data: SearchContentResponse }
  | {
      kind: "rate_limited";
      requestId: string | null;
      retryAfterMs: number;
    }
  | {
      kind: "unavailable";
      error?: V1ErrorResponse["error"] | undefined;
      requestId?: string | undefined;
    };

function publicContentSearchUrl(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/+$/u, "");
  return configured
    ? `${configured}${PUBLIC_CONTENT_SEARCH_PATH}`
    : PUBLIC_CONTENT_SEARCH_PATH;
}

function retryAfterMilliseconds(value: string | null, now: number): number | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  if (/^\d+$/u.test(normalized)) {
    const seconds = Number(normalized);
    return Number.isSafeInteger(seconds) && seconds > 0 ? seconds * 1_000 : null;
  }
  const retryAt = Date.parse(normalized);
  if (!Number.isFinite(retryAt)) return null;
  return retryAt > now ? retryAt - now : null;
}

function failedSearchResult(
  response: Response,
  payload: unknown,
): BrowserContentSearchResult {
  const parsedError = V1ErrorResponseSchema.safeParse(payload);
  if (response.status === 429) {
    const retryAfter = retryAfterMilliseconds(
      response.headers.get("retry-after"),
      Date.now(),
    );
    const bodyRetryAfter = parsedError.success
      ? parsedError.data.error.retry_after_ms
      : null;
    return {
      kind: "rate_limited",
      requestId: parsedError.success ? parsedError.data.request_id : null,
      retryAfterMs: Math.max(1_000, retryAfter ?? 0, bodyRetryAfter ?? 0),
    };
  }
  return parsedError.success
    ? {
        error: parsedError.data.error,
        kind: "unavailable",
        requestId: parsedError.data.request_id,
      }
    : { kind: "unavailable" };
}

/**
 * Browser Search deliberately uses a POST body. The natural-language query and
 * opaque cursor must never be copied into an address, navigation state, cookie,
 * or browser storage merely to render or paginate public results.
 */
export async function searchPublicContentFromBrowser(
  request: SearchContentRequest,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<BrowserContentSearchResult> {
  const parsedRequest = SearchContentRequestSchema.safeParse(request);
  if (!parsedRequest.success) return { kind: "invalid" };

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) {
    abortFromCaller();
  } else {
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timeout = globalThis.setTimeout(
    () => controller.abort(new DOMException("Content Search timed out", "TimeoutError")),
    BROWSER_SEARCH_TIMEOUT_MILLISECONDS,
  );

  try {
    const response = await fetch(publicContentSearchUrl(), {
      body: JSON.stringify(parsedRequest.data),
      cache: "no-store",
      credentials: "omit",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      method: "POST",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) return failedSearchResult(response, payload);

    const parsedResponse = SearchContentResponseSchema.safeParse(payload);
    return parsedResponse.success
      ? { kind: "success", data: parsedResponse.data }
      : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  } finally {
    globalThis.clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}
