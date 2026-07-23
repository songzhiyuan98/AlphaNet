"use client";

import { OwnerAccountDataExportSchema, V1ErrorResponseSchema } from "@alphanet/contracts";

import { browserApiUrl, OwnerApiError } from "./browser-owner-api";

const fallbackFilename = "alphanet-account-data.json";

function responseFilename(value: string | null): string {
  if (!value) return fallbackFilename;
  const match = /filename="([a-z0-9][a-z0-9._-]{0,127}\.json)"/iu.exec(value);
  return match?.[1] ?? fallbackFilename;
}

export interface OwnerAccountExportDownload {
  filename: string;
  json: string;
}

export async function requestOwnerAccountExport(): Promise<OwnerAccountExportDownload> {
  let response: Response;
  try {
    response = await fetch(browserApiUrl("/v1/owner/account-data-export"), {
      credentials: "include",
      headers: { accept: "application/json" },
      method: "POST",
    });
  } catch {
    throw new OwnerApiError({
      code: "NETWORK_ERROR",
      message: "无法连接控制面，请检查网络后重试。",
    });
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = V1ErrorResponseSchema.safeParse(payload);
    if (parsed.success) {
      throw new OwnerApiError({
        code: parsed.data.error.code,
        message: parsed.data.error.message,
        requestId: parsed.data.request_id,
        retryAfterMs: parsed.data.error.retry_after_ms,
      });
    }
    throw new OwnerApiError({
      code: response.status === 401 ? "AUTHENTICATION_REQUIRED" : "API_ERROR",
      message: "账户数据导出未能完成，请稍后重试。",
    });
  }

  const parsed = OwnerAccountDataExportSchema.safeParse(payload);
  if (!parsed.success) {
    throw new OwnerApiError({
      code: "INVALID_RESPONSE",
      message: "控制面返回了无法识别的导出数据，请稍后重试。",
    });
  }

  return {
    filename: responseFilename(response.headers.get("content-disposition")),
    json: `${JSON.stringify(parsed.data, null, 2)}\n`,
  };
}
