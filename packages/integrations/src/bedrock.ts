import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  type InvokeModelCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import type { BedrockInvokeModelTransport } from "@alphanet/domain";

interface BedrockRuntimeClientLike {
  destroy?: (() => void) | undefined;
  send(
    command: InvokeModelCommand,
    options: { abortSignal: AbortSignal },
  ): Promise<InvokeModelCommandOutput>;
}

export interface AwsBedrockInvokeModelTransportOptions {
  client?: BedrockRuntimeClientLike | undefined;
  region?: string | undefined;
}

/**
 * Thin AWS SDK adapter. Titan request construction, response validation and
 * timeout policy remain in the Search domain so API and Worker cannot drift.
 */
export class AwsBedrockInvokeModelTransport implements BedrockInvokeModelTransport {
  readonly #client: BedrockRuntimeClientLike;

  constructor(options: AwsBedrockInvokeModelTransportOptions = {}) {
    this.#client =
      options.client ??
      new BedrockRuntimeClient({
        ...(options.region === undefined ? {} : { region: options.region }),
      });
  }

  async invokeModel(input: {
    abortSignal: AbortSignal;
    accept: "application/json";
    body: Uint8Array;
    contentType: "application/json";
    modelId: string;
  }): Promise<{ body: Uint8Array }> {
    const response = await this.#client.send(
      new InvokeModelCommand({
        accept: input.accept,
        body: input.body,
        contentType: input.contentType,
        modelId: input.modelId,
      }),
      { abortSignal: input.abortSignal },
    );
    if (!(response.body instanceof Uint8Array)) {
      throw new Error("Bedrock InvokeModel returned no byte response body.");
    }
    return { body: response.body };
  }

  destroy(): void {
    this.#client.destroy?.();
  }
}
