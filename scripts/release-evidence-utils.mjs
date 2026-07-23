import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export function requireReleaseSha(value) {
  const releaseSha = value?.trim() ?? "";
  if (!/^[0-9a-f]{40}$/u.test(releaseSha)) {
    throw new Error("RELEASE_SHA must be a full lowercase commit SHA.");
  }
  return releaseSha;
}

export function requireTargetEnvironment(value) {
  const targetEnvironment = value?.trim() ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/u.test(targetEnvironment)) {
    throw new Error("TARGET_ENV must be a 2-64 character environment identifier.");
  }
  return targetEnvironment;
}

export function requireBaseUrl(value, { allowLocalHttp = false } = {}) {
  const candidate = value?.trim() ?? "";
  if (candidate.length === 0) throw new Error("BASE_URL is required.");

  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("BASE_URL must be an absolute URL.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("BASE_URL cannot contain credentials, a query, or a fragment.");
  }
  const isLocal =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";
  if (url.protocol !== "https:" && !(allowLocalHttp && isLocal)) {
    throw new Error(
      "Remote release evidence requires HTTPS; local HTTP requires ALLOW_LOCAL_HTTP=1.",
    );
  }
  return url.href.replace(/\/+$/u, "");
}

export function positiveInteger(value, fallback, name) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function nonnegativeInteger(value, fallback, name) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function fetchJson(url, options, { timeoutMilliseconds = 15_000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
  const startedAt = performance.now();
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body;
    try {
      body = text.length === 0 ? null : JSON.parse(text);
    } catch {
      throw new Error(
        `Expected JSON from ${new URL(url).pathname}; received HTTP ${response.status}.`,
      );
    }
    return {
      body,
      durationMilliseconds: Math.max(0, performance.now() - startedAt),
      headers: response.headers,
      status: response.status,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function percentile(values, percentage) {
  if (values.length === 0) throw new Error("Cannot calculate an empty percentile.");
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((percentage / 100) * ordered.length) - 1);
  return ordered[index];
}

export async function writePrivateJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(filePath, 0o600);
}

export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
