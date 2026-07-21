import { describe, expect, it } from "vitest";

import {
  BedrockTitanV2EmbeddingProvider,
  TITAN_TEXT_EMBED_V2_MODEL_ID,
  type BedrockInvokeModelTransport,
  type EmbeddingProviderError,
} from "./bedrock-embedding.js";

const component = 1 / Math.sqrt(512);
const validEmbedding = Array.from({ length: 512 }, () => component);

describe("BedrockTitanV2EmbeddingProvider", () => {
  it("sends the fixed 512-dimensional normalized Titan v2 protocol", async () => {
    let captured: Parameters<BedrockInvokeModelTransport["invokeModel"]>[0] | undefined;
    const provider = new BedrockTitanV2EmbeddingProvider({
      invokeModel(input) {
        captured = input;
        return Promise.resolve({
          body: new TextEncoder().encode(
            JSON.stringify({ embedding: validEmbedding, inputTextTokenCount: 4 }),
          ),
        });
      },
    });

    await expect(provider.embed("  ＡＭＤ\r\nresearch  ")).resolves.toHaveLength(512);
    expect(captured?.modelId).toBe(TITAN_TEXT_EMBED_V2_MODEL_ID);
    expect(JSON.parse(new TextDecoder().decode(captured?.body))).toEqual({
      dimensions: 512,
      inputText: "AMD\nresearch",
      normalize: true,
    });
  });

  it("rejects malformed, wrong-dimensional, and non-normalized responses", async () => {
    for (const response of [
      { embedding: [1] },
      { embedding: Array.from({ length: 512 }, () => 0) },
      { embedding: validEmbedding, unexpected: true },
    ]) {
      const provider = new BedrockTitanV2EmbeddingProvider({
        invokeModel() {
          return Promise.resolve({
            body: new TextEncoder().encode(JSON.stringify(response)),
          });
        },
      });
      await expect(provider.embed("AMD")).rejects.toMatchObject({
        code: "INVALID_RESPONSE",
      });
    }
  });

  it("rejects a model override that would drift from the Search v1 index", () => {
    expect(
      () =>
        new BedrockTitanV2EmbeddingProvider(
          { invokeModel: () => Promise.reject(new Error("must not be called")) },
          { modelId: "amazon.titan-embed-text-v1" },
        ),
    ).toThrow(`AlphaNet Search v1 requires ${TITAN_TEXT_EMBED_V2_MODEL_ID}.`);
  });

  it("bounds provider calls with an abortable timeout", async () => {
    const provider = new BedrockTitanV2EmbeddingProvider(
      {
        invokeModel(input) {
          return new Promise((_resolve, reject) => {
            input.abortSignal.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            );
          });
        },
      },
      { timeoutMilliseconds: 100 },
    );
    await expect(provider.embed("AMD")).rejects.toEqual(
      expect.objectContaining<Partial<EmbeddingProviderError>>({ code: "TIMEOUT" }),
    );
  });
});
