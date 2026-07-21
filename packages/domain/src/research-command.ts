import { createHash } from "node:crypto";

export type ContentRelationType = "quote" | "reference";

export interface ResearchSourceLinkInput {
  url: string;
  title?: string | undefined;
  description?: string | undefined;
}

export interface ResearchContentReferenceInput {
  targetContentId: string;
  relationType: ContentRelationType;
}

export interface CreatePostCommandInput {
  title: string;
  bodyMarkdown: string;
  primaryCommunityId: string;
  additionalCommunityIds?: readonly string[] | undefined;
  symbols?: readonly string[] | undefined;
  topics?: readonly string[] | undefined;
  sourceLinks?: readonly ResearchSourceLinkInput[] | undefined;
  references?: readonly ResearchContentReferenceInput[] | undefined;
}

export interface ReplyCommandInput {
  parentContentId: string;
  bodyMarkdown: string;
  symbols?: readonly string[] | undefined;
  topics?: readonly string[] | undefined;
  sourceLinks?: readonly ResearchSourceLinkInput[] | undefined;
  references?: readonly ResearchContentReferenceInput[] | undefined;
}

export interface UpdateContentPatchInput {
  title?: string | undefined;
  bodyMarkdown?: string | undefined;
  sourceLinks?: readonly ResearchSourceLinkInput[] | undefined;
  references?: readonly ResearchContentReferenceInput[] | undefined;
  additionalCommunityIds?: readonly string[] | undefined;
  symbols?: readonly string[] | undefined;
  topics?: readonly string[] | undefined;
}

export interface UpdateContentCommandInput {
  contentId: string;
  expectedVersion: number;
  patch: UpdateContentPatchInput;
  editSummary?: string | undefined;
}

export interface NormalizedResearchSourceLink {
  url: string;
  title?: string | undefined;
  description?: string | undefined;
}

export interface NormalizedResearchContentReference {
  targetContentId: string;
  relationType: ContentRelationType;
}

interface NormalizedResearchCommandFields {
  bodyMarkdown: string;
  symbols: string[];
  topics: string[];
  sourceLinks: NormalizedResearchSourceLink[];
  references: NormalizedResearchContentReference[];
  frozenMentionActorIds?: string[] | undefined;
}

export interface NormalizedCreatePostCommand extends NormalizedResearchCommandFields {
  operation: "create_post";
  title: string;
  primaryCommunityId: string;
  additionalCommunityIds: string[];
}

export interface NormalizedReplyCommand extends NormalizedResearchCommandFields {
  operation: "reply_to_content";
  parentContentId: string;
}

export interface NormalizedUpdateContentPatch {
  title?: string | undefined;
  bodyMarkdown?: string | undefined;
  sourceLinks?: NormalizedResearchSourceLink[] | undefined;
  references?: NormalizedResearchContentReference[] | undefined;
  additionalCommunityIds?: string[] | undefined;
  symbols?: string[] | undefined;
  topics?: string[] | undefined;
}

export interface FrozenUpdateContentBaseline {
  additionalCommunityIds: string[];
  bodyMarkdown: string;
  contentKind: "post" | "reply";
  primaryCommunityId: string;
  resourceVersion: number;
  revisionId: string;
  title: string | null;
}

export interface NormalizedUpdateContentCommand {
  operation: "update_content";
  contentId: string;
  expectedVersion: number;
  patch: NormalizedUpdateContentPatch;
  editSummary?: string | undefined;
  frozenMentionActorIds?: string[] | undefined;
  frozenUpdateBaseline?: FrozenUpdateContentBaseline | undefined;
}

export type NormalizedResearchCommand =
  NormalizedCreatePostCommand | NormalizedReplyCommand | NormalizedUpdateContentCommand;

export type ResearchCommandValidationErrorCode =
  | "DUPLICATE_COMMUNITY_TARGET"
  | "IDENTIFIER_INVALID"
  | "PATCH_EMPTY"
  | "SOURCE_LINK_CONFLICT"
  | "SOURCE_URL_INVALID"
  | "SYMBOL_INVALID"
  | "TEXT_INVALID"
  | "TOPIC_INVALID"
  | "VERSION_INVALID";

export class ResearchCommandValidationError extends Error {
  readonly code: ResearchCommandValidationErrorCode;

  constructor(code: ResearchCommandValidationErrorCode, message: string) {
    super(message);
    this.name = "ResearchCommandValidationError";
    this.code = code;
  }
}

function normalizeText(value: string): string {
  const normalized = value
    .normalize("NFC")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
  if (normalized.includes("\u0000")) {
    throw new ResearchCommandValidationError(
      "TEXT_INVALID",
      "Research command text cannot contain the NUL character.",
    );
  }
  return normalized;
}

function normalizeLabel(value: string): string {
  return normalizeText(value).trim();
}

function normalizeIdentifier(value: string): string {
  const normalized = normalizeLabel(value);
  if (normalized.length === 0 || normalized.length > 200) {
    throw new ResearchCommandValidationError(
      "IDENTIFIER_INVALID",
      "Research command identifiers cannot be blank.",
    );
  }
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    normalized,
  )
    ? normalized.toLowerCase()
    : normalized;
}

function normalizeSymbols(values: readonly string[] | undefined): string[] {
  const normalized = (values ?? []).map((value) =>
    normalizeLabel(value).toLocaleUpperCase("en-US"),
  );
  for (const symbol of normalized) {
    if (!/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(symbol)) {
      throw new ResearchCommandValidationError(
        "SYMBOL_INVALID",
        "Symbols must use the canonical market-symbol format.",
      );
    }
  }
  return [...new Set(normalized)].sort();
}

function normalizeTopics(values: readonly string[] | undefined): string[] {
  const normalized = (values ?? []).map((value) =>
    normalizeLabel(value).toLocaleLowerCase("en-US"),
  );
  for (const topic of normalized) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(topic)) {
      throw new ResearchCommandValidationError(
        "TOPIC_INVALID",
        "Topics must use the canonical lower-case slug format.",
      );
    }
  }
  return [...new Set(normalized)].sort();
}

function normalizeSourceUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(normalizeLabel(value));
  } catch {
    throw new ResearchCommandValidationError(
      "SOURCE_URL_INVALID",
      "Source links must be absolute HTTPS URLs.",
    );
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
    throw new ResearchCommandValidationError(
      "SOURCE_URL_INVALID",
      "Source links must be credential-free HTTPS URLs.",
    );
  }
  return parsed.toString();
}

function normalizeOptionalLabel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizeLabel(value);
  return normalized.length === 0 ? undefined : normalized;
}

function normalizeSourceLinks(
  values: readonly ResearchSourceLinkInput[] | undefined,
): NormalizedResearchSourceLink[] {
  const byUrl = new Map<string, NormalizedResearchSourceLink>();
  for (const value of values ?? []) {
    const source = {
      url: normalizeSourceUrl(value.url),
      ...(normalizeOptionalLabel(value.title)
        ? { title: normalizeOptionalLabel(value.title)! }
        : {}),
      ...(normalizeOptionalLabel(value.description)
        ? { description: normalizeOptionalLabel(value.description)! }
        : {}),
    };
    const existing = byUrl.get(source.url);
    if (existing && canonicalJson(existing) !== canonicalJson(source)) {
      throw new ResearchCommandValidationError(
        "SOURCE_LINK_CONFLICT",
        "One normalized source URL cannot carry conflicting metadata.",
      );
    }
    byUrl.set(source.url, source);
  }
  return [...byUrl.values()].sort((left, right) => left.url.localeCompare(right.url));
}

function normalizeReferences(
  values: readonly ResearchContentReferenceInput[] | undefined,
): NormalizedResearchContentReference[] {
  const byKey = new Map<string, NormalizedResearchContentReference>();
  for (const value of values ?? []) {
    const reference = {
      targetContentId: normalizeIdentifier(value.targetContentId),
      relationType: value.relationType,
    };
    byKey.set(`${reference.targetContentId}\u0000${reference.relationType}`, reference);
  }
  return [...byKey.values()].sort((left, right) =>
    `${left.targetContentId}:${left.relationType}`.localeCompare(
      `${right.targetContentId}:${right.relationType}`,
    ),
  );
}

function normalizeCommonFields(
  input: Pick<
    CreatePostCommandInput,
    "bodyMarkdown" | "symbols" | "topics" | "sourceLinks" | "references"
  >,
): NormalizedResearchCommandFields {
  return {
    bodyMarkdown: normalizeText(input.bodyMarkdown),
    symbols: normalizeSymbols(input.symbols),
    topics: normalizeTopics(input.topics),
    sourceLinks: normalizeSourceLinks(input.sourceLinks),
    references: normalizeReferences(input.references),
  };
}

export function normalizeCreatePostCommand(
  input: CreatePostCommandInput,
): NormalizedCreatePostCommand {
  const primaryCommunityId = normalizeIdentifier(input.primaryCommunityId);
  const additionalCommunityIds = (input.additionalCommunityIds ?? []).map(
    normalizeIdentifier,
  );
  const allTargets = [primaryCommunityId, ...additionalCommunityIds];
  if (new Set(allTargets).size !== allTargets.length) {
    throw new ResearchCommandValidationError(
      "DUPLICATE_COMMUNITY_TARGET",
      "Primary and additional community targets must be unique.",
    );
  }
  return {
    operation: "create_post",
    title: normalizeLabel(input.title),
    bodyMarkdown: normalizeText(input.bodyMarkdown),
    primaryCommunityId,
    additionalCommunityIds,
    symbols: normalizeSymbols(input.symbols),
    topics: normalizeTopics(input.topics),
    sourceLinks: normalizeSourceLinks(input.sourceLinks),
    references: normalizeReferences(input.references),
  };
}

export function normalizeReplyCommand(input: ReplyCommandInput): NormalizedReplyCommand {
  return {
    operation: "reply_to_content",
    parentContentId: normalizeIdentifier(input.parentContentId),
    ...normalizeCommonFields(input),
  };
}

export function normalizeUpdateContentCommand(
  input: UpdateContentCommandInput,
): NormalizedUpdateContentCommand {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new ResearchCommandValidationError(
      "VERSION_INVALID",
      "The expected content version must be a positive safe integer.",
    );
  }

  const patch: NormalizedUpdateContentPatch = {};
  if (input.patch.title !== undefined) {
    patch.title = normalizeLabel(input.patch.title);
  }
  if (input.patch.bodyMarkdown !== undefined) {
    patch.bodyMarkdown = normalizeText(input.patch.bodyMarkdown);
  }
  if (input.patch.sourceLinks !== undefined) {
    patch.sourceLinks = normalizeSourceLinks(input.patch.sourceLinks);
  }
  if (input.patch.references !== undefined) {
    patch.references = normalizeReferences(input.patch.references);
  }
  if (input.patch.additionalCommunityIds !== undefined) {
    patch.additionalCommunityIds =
      input.patch.additionalCommunityIds.map(normalizeIdentifier);
    if (
      new Set(patch.additionalCommunityIds).size !== patch.additionalCommunityIds.length
    ) {
      throw new ResearchCommandValidationError(
        "DUPLICATE_COMMUNITY_TARGET",
        "Additional community targets must be unique.",
      );
    }
  }
  if (input.patch.symbols !== undefined) {
    patch.symbols = normalizeSymbols(input.patch.symbols);
  }
  if (input.patch.topics !== undefined) {
    patch.topics = normalizeTopics(input.patch.topics);
  }
  if (Object.keys(patch).length === 0) {
    throw new ResearchCommandValidationError(
      "PATCH_EMPTY",
      "An update command must contain at least one mutable field.",
    );
  }

  let editSummary: string | undefined;
  if (input.editSummary !== undefined) {
    editSummary = normalizeOptionalLabel(input.editSummary);
    if (editSummary === undefined) {
      throw new ResearchCommandValidationError(
        "TEXT_INVALID",
        "An edit summary cannot be blank when provided.",
      );
    }
  }

  return {
    operation: "update_content",
    contentId: normalizeIdentifier(input.contentId),
    expectedVersion: input.expectedVersion,
    patch,
    ...(editSummary === undefined ? {} : { editSummary }),
  };
}

export function freezeResearchCommandMentionActors<T extends NormalizedResearchCommand>(
  command: T,
  actorIds: readonly string[],
): T {
  const normalizedActorIds = actorIds.map(normalizeIdentifier);
  if (new Set(normalizedActorIds).size !== normalizedActorIds.length) {
    throw new ResearchCommandValidationError(
      "IDENTIFIER_INVALID",
      "Frozen mention recipients must be unique.",
    );
  }
  return {
    ...command,
    frozenMentionActorIds: normalizedActorIds,
  };
}

export function freezeUpdateContentBaseline(
  command: NormalizedUpdateContentCommand,
  baseline: FrozenUpdateContentBaseline,
): NormalizedUpdateContentCommand {
  if (
    !Number.isSafeInteger(baseline.resourceVersion) ||
    baseline.resourceVersion < 1 ||
    baseline.resourceVersion !== command.expectedVersion
  ) {
    throw new ResearchCommandValidationError(
      "VERSION_INVALID",
      "The frozen update baseline must match the expected content version.",
    );
  }
  const revisionId = normalizeIdentifier(baseline.revisionId);
  const primaryCommunityId = normalizeIdentifier(baseline.primaryCommunityId);
  const additionalCommunityIds = baseline.additionalCommunityIds.map(normalizeIdentifier);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      revisionId,
    ) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      primaryCommunityId,
    ) ||
    additionalCommunityIds.length > 4 ||
    additionalCommunityIds.some(
      (communityId) =>
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
          communityId,
        ),
    ) ||
    new Set([primaryCommunityId, ...additionalCommunityIds]).size !==
      1 + additionalCommunityIds.length
  ) {
    throw new ResearchCommandValidationError(
      "IDENTIFIER_INVALID",
      "The frozen update baseline contains invalid Community or Revision identity.",
    );
  }
  const bodyMarkdown = normalizeText(baseline.bodyMarkdown);
  const title = baseline.title === null ? null : normalizeLabel(baseline.title);
  if (
    bodyMarkdown.trim().length === 0 ||
    (baseline.contentKind === "post" &&
      (title === null || [...title].length < 5 || [...title].length > 200)) ||
    (baseline.contentKind === "reply" && title !== null)
  ) {
    throw new ResearchCommandValidationError(
      "TEXT_INVALID",
      "The frozen update baseline contradicts the content kind or text limits.",
    );
  }
  return {
    ...command,
    frozenUpdateBaseline: {
      additionalCommunityIds,
      bodyMarkdown,
      contentKind: baseline.contentKind,
      primaryCommunityId,
      resourceVersion: baseline.resourceVersion,
      revisionId,
      title,
    },
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function digestResearchCommand(command: NormalizedResearchCommand): string {
  return `sha256:${digestResearchCommandBytes(command).toString("hex")}`;
}

export function digestResearchCommandBytes(command: NormalizedResearchCommand): Buffer {
  const clientCommand: Record<string, unknown> = { ...command };
  delete clientCommand.frozenMentionActorIds;
  delete clientCommand.frozenUpdateBaseline;
  return createHash("sha256").update(canonicalJson(clientCommand)).digest();
}
