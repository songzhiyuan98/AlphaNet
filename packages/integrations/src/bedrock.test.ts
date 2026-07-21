import {
  type InvokeModelCommand,
  type InvokeModelCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it, vi } from "vitest";

import { AwsBedrockInvokeModelTransport } from "./bedrock.js";

describe("AwsBedrockInvokeModelTransport", () => {
  it("maps the domain request to InvokeModel without owning credentials", async () => {
    const send = vi.fn<
      (
        command: InvokeModelCommand,
        options: { abortSignal: AbortSignal },
      ) => Promise<InvokeModelCommandOutput>
    >(() =>
      Promise.resolve({
        $metadata: {},
        body: new Uint8Array([1, 2, 3]),
        contentType: "application/json",
      } as unknown as InvokeModelCommandOutput),
    );
    const destroy = vi.fn();
    const transport = new AwsBedrockInvokeModelTransport({
      client: { destroy, send },
    });
    const abortSignal = new AbortController().signal;

    await expect(
      transport.invokeModel({
        abortSignal,
        accept: "application/json",
        body: new Uint8Array([4, 5]),
        contentType: "application/json",
        modelId: "amazon.titan-embed-text-v2:0",
      }),
    ).resolves.toEqual({ body: new Uint8Array([1, 2, 3]) });

    const [command, options] = send.mock.calls[0]!;
    expect(command.input).toMatchObject({
      accept: "application/json",
      body: new Uint8Array([4, 5]),
      contentType: "application/json",
      modelId: "amazon.titan-embed-text-v2:0",
    });
    expect(options).toEqual({ abortSignal });

    transport.destroy();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("fails closed when the SDK omits the response body", async () => {
    const send = vi.fn<
      (
        command: InvokeModelCommand,
        options: { abortSignal: AbortSignal },
      ) => Promise<InvokeModelCommandOutput>
    >(() =>
      Promise.resolve({
        $metadata: {},
        body: undefined,
        contentType: "application/json",
      } as unknown as InvokeModelCommandOutput),
    );
    const transport = new AwsBedrockInvokeModelTransport({
      client: { send },
    });

    await expect(
      transport.invokeModel({
        abortSignal: new AbortController().signal,
        accept: "application/json",
        body: new Uint8Array([1]),
        contentType: "application/json",
        modelId: "amazon.titan-embed-text-v2:0",
      }),
    ).rejects.toThrow("no byte response body");
  });
});
