import {
  AGENT_TOOL_SCOPE_POLICIES,
  AgentScopeSchema,
  AgentToolNameSchema,
  V1ErrorResponseSchema,
  type AgentScope,
  type AgentToolName,
  type AgentToolScopePolicy,
} from "@alphanet/contracts";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  ToolSchema,
  type CallToolResult,
  type RequestId,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import type { Logger } from "pino";
import { z } from "zod";

export const MCP_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MCP_TOOL_TIMEOUT_MILLISECONDS = 30_000;

export interface McpToolAuthorizationContext {
  credentialId: string;
  clientId: string;
  expiresAt: number;
  grantId: string;
  resource: string;
  scopes: readonly AgentScope[];
  tokenJtiDigest: string;
}

export interface McpToolExecutionContext {
  authorization: McpToolAuthorizationContext;
  requestId: string;
  signal: AbortSignal;
}

export interface McpToolExecutionResult {
  isError?: boolean;
  payload: Record<string, unknown>;
}

export interface McpToolRegistration {
  definition: Omit<Tool, "outputSchema"> & { outputSchema?: never };
  execute: (
    argumentsValue: Record<string, unknown>,
    context: McpToolExecutionContext,
  ) => Promise<McpToolExecutionResult> | McpToolExecutionResult;
  parseArguments: (value: unknown) => Record<string, unknown>;
  parseOutput: (value: unknown) => Record<string, unknown>;
  successOutputSchema: NonNullable<Tool["outputSchema"]>;
}

interface RegisteredMcpTool {
  definition: Tool;
  execute: McpToolRegistration["execute"];
  parseArguments: McpToolRegistration["parseArguments"];
  parseOutput: McpToolRegistration["parseOutput"];
  validateArguments: ValidateFunction;
  validateOutput: ValidateFunction;
}

export interface McpProtocolServerOptions {
  executionRegistry: McpExecutionRegistry;
  logger: Logger;
  requestId: string;
  toolTimeoutMilliseconds?: number;
  tools?: readonly McpToolRegistration[];
  version: string;
}

interface StructuredResultOptions {
  isError?: boolean;
  requestId: RequestId;
}

const McpActorAuthorizationSchema = z
  .object({
    credentialId: z.uuid(),
    grantId: z.uuid(),
    tokenJtiDigest: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/, "Expected a 32-byte base64url digest."),
  })
  .strict();

export type McpActorAuthorization = z.infer<typeof McpActorAuthorizationSchema>;

const MCP_V1_ERROR_OUTPUT_SCHEMA = {
  type: "object",
  required: ["error", "request_id", "schema_version"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message", "retryable", "details", "retry_after_ms"],
      properties: {
        code: { type: "string", minLength: 1, maxLength: 100 },
        message: { type: "string", minLength: 1, maxLength: 2_000 },
        retryable: { type: "boolean" },
        details: { type: ["object", "null"] },
        retry_after_ms: {
          type: ["integer", "null"],
          minimum: 1,
        },
      },
      additionalProperties: false,
    },
    request_id: { type: "string", minLength: 1, maxLength: 200 },
    schema_version: { const: "1" },
  },
  additionalProperties: false,
} as const;

const emptyToolRegistrations: readonly McpToolRegistration[] = Object.freeze([]);
const registryCache = new WeakMap<
  readonly McpToolRegistration[],
  ReadonlyMap<string, RegisteredMcpTool>
>();

export class McpExecutionRegistry {
  readonly #controllers = new Set<AbortController>();

  abortAll(): void {
    for (const controller of this.#controllers) {
      controller.abort();
    }
    this.#controllers.clear();
  }

  register(controller: AbortController): () => void {
    this.#controllers.add(controller);
    return () => {
      this.#controllers.delete(controller);
    };
  }
}

export function parseMcpActorAuthorization(value: unknown): McpActorAuthorization | null {
  const parsed = McpActorAuthorizationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function serializeObjectPayload(payload: Record<string, unknown>): {
  normalizedPayload: Record<string, unknown>;
  text: string;
} {
  const text = JSON.stringify(payload);
  if (text === undefined) {
    throw new TypeError("MCP structured payload is not JSON serializable");
  }

  const normalizedPayload: unknown = JSON.parse(text);
  if (
    typeof normalizedPayload !== "object" ||
    normalizedPayload === null ||
    Array.isArray(normalizedPayload)
  ) {
    throw new TypeError("MCP structured payload must serialize to an object");
  }

  return {
    normalizedPayload: normalizedPayload as Record<string, unknown>,
    text,
  };
}

function createEquivalentResult(
  payload: Record<string, unknown>,
  isError: boolean,
): CallToolResult {
  const { normalizedPayload, text } = serializeObjectPayload(payload);

  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
    structuredContent: normalizedPayload,
    ...(isError ? { isError: true } : {}),
  };
}

function responseWireBytes(requestId: RequestId, result: unknown): number {
  return Buffer.byteLength(
    JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      result,
    }),
  );
}

function parseRecord(
  parser: (value: unknown) => Record<string, unknown>,
  value: unknown,
  label: string,
): Record<string, unknown> {
  const parsed = parser(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`${label} parser must return an object`);
  }
  return parsed;
}

function mcpToolErrorPayload(
  requestId: string,
  code: string,
  message: string,
  options: {
    details?: Record<string, string | number | boolean | null> | undefined;
    retryable?: boolean | undefined;
  } = {},
): Record<string, unknown> {
  return V1ErrorResponseSchema.parse({
    error: {
      code,
      details: options.details ?? null,
      message,
      retry_after_ms: null,
      retryable: options.retryable === true,
    },
    request_id: requestId,
    schema_version: "1",
  });
}

function createRegisteredToolResult(
  registration: RegisteredMcpTool,
  payload: Record<string, unknown>,
  options: StructuredResultOptions & { serverRequestId: string },
): CallToolResult {
  const parsedPayload = parseAndValidateOutput(registration, payload);
  const result = createEquivalentResult(parsedPayload, options.isError === true);
  if (responseWireBytes(options.requestId, result) <= MCP_MAX_RESPONSE_BYTES) {
    return result;
  }

  const oversizedPayload = mcpToolErrorPayload(
    options.serverRequestId,
    "RESULT_TOO_LARGE",
    "Tool response exceeds the MCP wire limit.",
    {
      details: { maximum_wire_bytes: MCP_MAX_RESPONSE_BYTES },
    },
  );
  const parsedOversizedPayload = parseAndValidateOutput(registration, oversizedPayload);
  const oversizedResult = createEquivalentResult(parsedOversizedPayload, true);
  if (responseWireBytes(options.requestId, oversizedResult) > MCP_MAX_RESPONSE_BYTES) {
    throw new McpError(
      ErrorCode.InternalError,
      "Tool error response exceeds the MCP wire limit.",
    );
  }
  return oversizedResult;
}

function parseAndValidateOutput(
  registration: RegisteredMcpTool,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  try {
    const normalizedPayload = serializeObjectPayload(payload).normalizedPayload;
    const parserOutput = parseRecord(
      registration.parseOutput,
      normalizedPayload,
      "MCP tool output",
    );
    const finalPayload = serializeObjectPayload(parserOutput).normalizedPayload;
    if (!registration.validateOutput(finalPayload)) {
      throw new TypeError("MCP tool output does not match outputSchema");
    }
    return finalPayload;
  } catch {
    throw new McpError(ErrorCode.InternalError, "Tool result validation failed.");
  }
}

function buildRegistry(
  registrations: readonly McpToolRegistration[],
): ReadonlyMap<string, RegisteredMcpTool> {
  const cached = registryCache.get(registrations);
  if (cached) {
    return cached;
  }
  const registry = new Map<string, RegisteredMcpTool>();
  const ajv = new Ajv2020({
    allErrors: false,
    strict: false,
    validateFormats: false,
  });

  for (const registration of registrations) {
    if (!registration.successOutputSchema) {
      throw new Error(
        `MCP tool successOutputSchema is required: ${registration.definition.name}`,
      );
    }
    const outputSchema = {
      type: "object",
      anyOf: [registration.successOutputSchema, MCP_V1_ERROR_OUTPUT_SCHEMA],
    } as const;
    const definition = ToolSchema.parse({
      ...registration.definition,
      outputSchema,
    });
    if (definition.name === "get_platform_status") {
      throw new Error(
        "get_platform_status is operational health data and cannot be published as an MCP tool",
      );
    }
    const toolName = AgentToolNameSchema.parse(definition.name);
    if (registry.has(toolName)) {
      throw new Error(`Duplicate MCP tool registration: ${definition.name}`);
    }
    if (
      definition.execution?.taskSupport &&
      definition.execution.taskSupport !== "forbidden"
    ) {
      throw new Error(`MCP Tasks are not enabled in v1: ${definition.name}`);
    }
    if (
      typeof registration.parseArguments !== "function" ||
      typeof registration.parseOutput !== "function"
    ) {
      throw new Error(`MCP tool parsers are required: ${definition.name}`);
    }

    try {
      const validateArguments = ajv.compile(definition.inputSchema);
      const validateOutput = ajv.compile(outputSchema);
      registry.set(toolName, {
        definition,
        execute: registration.execute,
        parseArguments: registration.parseArguments,
        parseOutput: registration.parseOutput,
        validateArguments,
        validateOutput,
      });
    } catch {
      throw new Error(`MCP tool JSON Schema is invalid: ${definition.name}`);
    }
  }

  registryCache.set(registrations, registry);
  return registry;
}

export function createMcpToolScopeMap(
  registrations: readonly McpToolRegistration[],
): ReadonlyMap<string, AgentToolScopePolicy> {
  return new Map(
    [...buildRegistry(registrations).keys()].map((name) => [
      name,
      AGENT_TOOL_SCOPE_POLICIES[name as AgentToolName],
    ]),
  );
}

export function createProtocolServer(options: McpProtocolServerOptions): Server {
  const registry = buildRegistry(options.tools ?? emptyToolRegistrations);
  const publishedTools = [...registry.values()].map(({ definition }) => definition);
  const serverRequestId = z.uuid().parse(options.requestId);
  const toolTimeoutMilliseconds =
    options.toolTimeoutMilliseconds ?? MCP_TOOL_TIMEOUT_MILLISECONDS;
  if (
    !Number.isSafeInteger(toolTimeoutMilliseconds) ||
    toolTimeoutMilliseconds < 1 ||
    toolTimeoutMilliseconds > MCP_TOOL_TIMEOUT_MILLISECONDS
  ) {
    throw new Error("MCP tool timeout must be between 1 and 30000 milliseconds");
  }
  const server = new Server(
    {
      name: "alphanet",
      version: options.version,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, (_request, extra) => {
    const result = { tools: publishedTools };
    if (responseWireBytes(extra.requestId, result) > MCP_MAX_RESPONSE_BYTES) {
      throw new McpError(
        ErrorCode.InternalError,
        "Tool discovery response exceeds the MCP wire limit.",
      );
    }
    return result;
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (!extra.authInfo) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        "Authenticated request context is unavailable.",
      );
    }

    const actor = parseMcpActorAuthorization(extra.authInfo.extra?.actor);
    if (!actor) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        "Authenticated actor context is unavailable.",
      );
    }
    const expiresAt = extra.authInfo.expiresAt;
    if (
      typeof expiresAt !== "number" ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now() / 1_000
    ) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        "Authenticated token expiry is unavailable.",
      );
    }

    const registration = registry.get(request.params.name);
    if (!registration) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
    }

    let argumentsValue: Record<string, unknown>;
    try {
      if (!registration.validateArguments(request.params.arguments ?? {})) {
        throw new TypeError("MCP tool arguments do not match inputSchema");
      }
      argumentsValue = parseRecord(
        registration.parseArguments,
        request.params.arguments ?? {},
        "MCP tool argument",
      );
    } catch {
      return createRegisteredToolResult(
        registration,
        mcpToolErrorPayload(
          serverRequestId,
          "INVALID_ARGUMENTS",
          "Tool arguments do not match the published input schema.",
        ),
        {
          isError: true,
          requestId: extra.requestId,
          serverRequestId,
        },
      );
    }

    const executionController = new AbortController();
    const unregisterExecution = options.executionRegistry.register(executionController);

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      executionController.abort();
    }, toolTimeoutMilliseconds);

    try {
      const executionResult = await Promise.race([
        registration.execute(argumentsValue, {
          authorization: {
            credentialId: actor.credentialId,
            clientId: extra.authInfo.clientId,
            expiresAt,
            grantId: actor.grantId,
            resource: extra.authInfo.resource?.toString() ?? "",
            scopes: z.array(AgentScopeSchema).parse(extra.authInfo.scopes),
            tokenJtiDigest: actor.tokenJtiDigest,
          },
          requestId: serverRequestId,
          signal: executionController.signal,
        }),
        new Promise<never>((_resolve, reject) => {
          executionController.signal.addEventListener(
            "abort",
            () => reject(new Error(timedOut ? "McpToolTimeout" : "McpToolCancelled")),
            { once: true },
          );
        }),
      ]);

      return createRegisteredToolResult(registration, executionResult.payload, {
        isError: executionResult.isError === true,
        requestId: extra.requestId,
        serverRequestId,
      });
    } catch (error) {
      if (executionController.signal.aborted) {
        return createRegisteredToolResult(
          registration,
          mcpToolErrorPayload(
            serverRequestId,
            timedOut ? "TOOL_TIMEOUT" : "CANCELLED",
            timedOut
              ? "Tool execution exceeded the server time limit."
              : "Tool execution was cancelled.",
            { retryable: timedOut },
          ),
          {
            isError: true,
            requestId: extra.requestId,
            serverRequestId,
          },
        );
      }
      options.logger.error(
        { errorName: errorName(error), tool: request.params.name },
        "MCP tool execution failed",
      );

      return createRegisteredToolResult(
        registration,
        mcpToolErrorPayload(serverRequestId, "INTERNAL_ERROR", "Tool execution failed."),
        {
          isError: true,
          requestId: extra.requestId,
          serverRequestId,
        },
      );
    } finally {
      clearTimeout(timeout);
      unregisterExecution();
    }
  });

  return server;
}
