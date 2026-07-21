import { createHash } from "node:crypto";

export const TITAN_TEXT_EMBED_V2_MODEL_ID = "amazon.titan-embed-text-v2:0";
export const TITAN_TEXT_EMBED_V2_DIMENSIONS = 512;
export const TITAN_TEXT_EMBED_V2_INDEX_MODEL = `${TITAN_TEXT_EMBED_V2_MODEL_ID}:${TITAN_TEXT_EMBED_V2_DIMENSIONS}`;

const DEFAULT_TIMEOUT_MILLISECONDS = 2_500;
const MAXIMUM_INPUT_CODE_POINTS = 50_000;

export type EmbeddingProviderErrorCode =
  "ABORTED" | "INVALID_INPUT" | "INVALID_RESPONSE" | "TIMEOUT" | "UNAVAILABLE";

export class EmbeddingProviderError extends Error {
  readonly code: EmbeddingProviderErrorCode;
  readonly retryable: boolean;

  constructor(code: EmbeddingProviderErrorCode, options: { cause?: unknown } = {}) {
    super(embeddingErrorMessage(code), options);
    this.name = "EmbeddingProviderError";
    this.code = code;
    this.retryable = code === "TIMEOUT" || code === "UNAVAILABLE";
  }
}

export interface TextEmbeddingProvider {
  readonly dimensions: number;
  /** Stable storage identity. It includes dimensions, unlike the Bedrock model ID. */
  readonly indexModel: string;
  readonly modelId: string;
  embed(text: string, options?: { signal?: AbortSignal | undefined }): Promise<number[]>;
}

/**
 * Kept structural so the domain package does not own AWS credential or client
 * construction. The API/Worker adapter can wrap InvokeModelCommand while this
 * class owns Titan's request/response protocol and fail-closed validation.
 */
export interface BedrockInvokeModelTransport {
  invokeModel(input: {
    abortSignal: AbortSignal;
    accept: "application/json";
    body: Uint8Array;
    contentType: "application/json";
    modelId: string;
  }): Promise<{ body: Uint8Array }>;
}

export interface BedrockTitanV2EmbeddingProviderOptions {
  dimensions?: 512 | undefined;
  modelId?: string | undefined;
  normalize?: true | undefined;
  timeoutMilliseconds?: number | undefined;
}

export class BedrockTitanV2EmbeddingProvider implements TextEmbeddingProvider {
  readonly dimensions: number;
  readonly indexModel: string;
  readonly modelId: string;
  readonly #timeoutMilliseconds: number;
  readonly #transport: BedrockInvokeModelTransport;

  constructor(
    transport: BedrockInvokeModelTransport,
    options: BedrockTitanV2EmbeddingProviderOptions = {},
  ) {
    if (typeof transport?.invokeModel !== "function") {
      throw new TypeError("A Bedrock InvokeModel transport is required.");
    }
    if (options.dimensions !== undefined && options.dimensions !== 512) {
      throw new RangeError("AlphaNet Search v1 requires 512-dimensional embeddings.");
    }
    if (options.normalize !== undefined && options.normalize !== true) {
      throw new RangeError("AlphaNet Search v1 requires normalized Titan embeddings.");
    }
    const timeout = options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS;
    if (!Number.isInteger(timeout) || timeout < 100 || timeout > 30_000) {
      throw new RangeError("The embedding timeout must be between 100 and 30000 ms.");
    }
    const modelId = (options.modelId ?? TITAN_TEXT_EMBED_V2_MODEL_ID).trim();
    if (modelId !== TITAN_TEXT_EMBED_V2_MODEL_ID) {
      throw new TypeError(`AlphaNet Search v1 requires ${TITAN_TEXT_EMBED_V2_MODEL_ID}.`);
    }
    this.#transport = transport;
    this.#timeoutMilliseconds = timeout;
    this.dimensions = TITAN_TEXT_EMBED_V2_DIMENSIONS;
    this.modelId = modelId;
    this.indexModel = `${modelId}:${this.dimensions}`;
  }

  async embed(
    text: string,
    options: { signal?: AbortSignal | undefined } = {},
  ): Promise<number[]> {
    const normalized = normalizeEmbeddingInput(text);
    const timeoutController = new AbortController();
    const timeout = setTimeout(
      () => timeoutController.abort("timeout"),
      this.#timeoutMilliseconds,
    );
    timeout.unref?.();
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutController.signal])
      : timeoutController.signal;

    try {
      const body = new TextEncoder().encode(
        JSON.stringify({
          dimensions: this.dimensions,
          inputText: normalized,
          normalize: true,
        }),
      );
      let response: { body: Uint8Array };
      try {
        response = await this.#transport.invokeModel({
          abortSignal: signal,
          accept: "application/json",
          body,
          contentType: "application/json",
          modelId: this.modelId,
        });
      } catch (error) {
        if (options.signal?.aborted === true) {
          throw new EmbeddingProviderError("ABORTED", { cause: error });
        }
        if (timeoutController.signal.aborted) {
          throw new EmbeddingProviderError("TIMEOUT", { cause: error });
        }
        if (error instanceof EmbeddingProviderError) throw error;
        throw new EmbeddingProviderError("UNAVAILABLE", { cause: error });
      }
      if (!(response.body instanceof Uint8Array) || response.body.byteLength > 128_000) {
        throw new EmbeddingProviderError("INVALID_RESPONSE");
      }
      return parseTitanEmbeddingResponse(response.body, this.dimensions);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function normalizeEmbeddingInput(text: string): string {
  if (typeof text !== "string") {
    throw new EmbeddingProviderError("INVALID_INPUT");
  }
  const normalized = text.normalize("NFKC").replace(/\r\n?/gu, "\n").trim();
  const length = [...normalized].length;
  if (length < 1 || length > MAXIMUM_INPUT_CODE_POINTS || normalized.includes("\u0000")) {
    throw new EmbeddingProviderError("INVALID_INPUT");
  }
  return normalized;
}

export function embeddingSourceHash(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

function parseTitanEmbeddingResponse(body: Uint8Array, dimensions: number): number[] {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch (error) {
    throw new EmbeddingProviderError("INVALID_RESPONSE", { cause: error });
  }
  if (!isRecord(value)) {
    throw new EmbeddingProviderError("INVALID_RESPONSE");
  }
  const keys = Object.keys(value).sort();
  if (
    keys.some((key) => key !== "embedding" && key !== "inputTextTokenCount") ||
    !Array.isArray(value.embedding) ||
    value.embedding.length !== dimensions ||
    value.embedding.some(
      (component) =>
        typeof component !== "number" ||
        !Number.isFinite(component) ||
        Math.abs(component) > 1,
    ) ||
    (value.inputTextTokenCount !== undefined &&
      (typeof value.inputTextTokenCount !== "number" ||
        !Number.isSafeInteger(value.inputTextTokenCount) ||
        value.inputTextTokenCount < 1 ||
        value.inputTextTokenCount > 32_000))
  ) {
    throw new EmbeddingProviderError("INVALID_RESPONSE");
  }
  const embedding = value.embedding as number[];
  const magnitude = Math.sqrt(
    embedding.reduce((sum, component) => sum + component * component, 0),
  );
  // Titan normalize=true is part of the index contract. A non-normalized
  // response would silently change cosine ranking and must not enter pgvector.
  if (magnitude < 0.98 || magnitude > 1.02) {
    throw new EmbeddingProviderError("INVALID_RESPONSE");
  }
  return [...embedding];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function embeddingErrorMessage(code: EmbeddingProviderErrorCode): string {
  switch (code) {
    case "ABORTED":
      return "Embedding generation was aborted.";
    case "INVALID_INPUT":
      return "Embedding input is invalid.";
    case "INVALID_RESPONSE":
      return "The embedding provider returned an invalid response.";
    case "TIMEOUT":
      return "The embedding provider timed out.";
    case "UNAVAILABLE":
      return "The embedding provider is unavailable.";
  }
}
