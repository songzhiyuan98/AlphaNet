import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  digestResearchCommand,
  freezeResearchCommandMentionActors,
  freezeUpdateContentBaseline,
  normalizeCreatePostCommand,
  normalizeDeleteContentCommand,
  normalizeReplyCommand,
  normalizeUpdateContentCommand,
  type NormalizedResearchCommand,
  type FrozenUpdateContentBaseline,
  type UpdateContentPatchInput,
} from "./research-command.js";

const ALGORITHM = "aes-256-gcm";
const AUTH_TAG_BYTES = 16;
const FORMAT_VERSION = 1;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;

export interface PendingCommandAuthority {
  actionId: string;
  ownerId: string;
  agentId: string;
  credentialId: string;
  operation: NormalizedResearchCommand["operation"];
  inputDigest: string;
}

export interface PendingCommandKeyRing {
  currentVersion: number;
  keys: Readonly<Record<number, Uint8Array>>;
}

export interface EncryptedPendingCommand {
  ciphertext: Buffer;
  nonce: Buffer;
  keyVersion: number;
  formatVersion: number;
}

export type PendingCommandCodecErrorCode =
  | "PENDING_COMMAND_AUTHENTICATION_FAILED"
  | "PENDING_COMMAND_FORMAT_UNSUPPORTED"
  | "PENDING_COMMAND_KEY_INVALID"
  | "PENDING_COMMAND_PAYLOAD_INVALID";

export class PendingCommandCodecError extends Error {
  readonly code: PendingCommandCodecErrorCode;

  constructor(code: PendingCommandCodecErrorCode) {
    super("The frozen PendingAction command could not be processed.");
    this.name = "PendingCommandCodecError";
    this.code = code;
  }
}

function canonicalAuthority(authority: PendingCommandAuthority): Buffer {
  return Buffer.from(
    JSON.stringify({
      action_id: authority.actionId,
      agent_id: authority.agentId,
      credential_id: authority.credentialId,
      input_digest: authority.inputDigest,
      operation: authority.operation,
      owner_id: authority.ownerId,
      purpose: "alphanet.pending-action.normalized-command.v1",
    }),
    "utf8",
  );
}

function keyForVersion(keyRing: PendingCommandKeyRing, version: number): Buffer {
  const material = keyRing.keys[version];
  if (
    !Number.isInteger(version) ||
    version < 1 ||
    !material ||
    material.byteLength !== KEY_BYTES
  ) {
    throw new PendingCommandCodecError("PENDING_COMMAND_KEY_INVALID");
  }
  return Buffer.from(material);
}

function parseStringArray(value: unknown): string[] | null {
  return Array.isArray(value) &&
    value.every((item): item is string => typeof item === "string")
    ? value
    : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSourceLinks(
  value: unknown,
):
  { url: string; title?: string | undefined; description?: string | undefined }[] | null {
  if (!Array.isArray(value)) return null;
  const sources: {
    url: string;
    title?: string | undefined;
    description?: string | undefined;
  }[] = [];
  for (const item of value) {
    if (
      !isPlainRecord(item) ||
      !Object.keys(item).every((key) => ["url", "title", "description"].includes(key))
    ) {
      return null;
    }
    const url = item.url;
    const title = item.title;
    const description = item.description;
    if (
      typeof url !== "string" ||
      (title !== undefined && typeof title !== "string") ||
      (description !== undefined && typeof description !== "string")
    ) {
      return null;
    }
    sources.push({
      url,
      ...(title === undefined ? {} : { title }),
      ...(description === undefined ? {} : { description }),
    });
  }
  return sources;
}

function parseReferences(value: unknown):
  | {
      targetContentId: string;
      relationType: "quote" | "reference";
    }[]
  | null {
  if (!Array.isArray(value)) return null;
  const references: {
    targetContentId: string;
    relationType: "quote" | "reference";
  }[] = [];
  for (const item of value) {
    if (
      !isPlainRecord(item) ||
      !Object.keys(item).every((key) => ["targetContentId", "relationType"].includes(key))
    ) {
      return null;
    }
    const reference = item;
    const relationType = reference.relationType;
    if (
      typeof reference.targetContentId !== "string" ||
      (relationType !== "quote" && relationType !== "reference")
    ) {
      return null;
    }
    references.push({
      targetContentId: reference.targetContentId,
      relationType,
    });
  }
  return references;
}

function hasOwn(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function parseUpdatePatch(value: unknown): UpdateContentPatchInput | null {
  if (!isPlainRecord(value)) return null;
  const allowedKeys = [
    "title",
    "bodyMarkdown",
    "sourceLinks",
    "references",
    "additionalCommunityIds",
    "symbols",
    "topics",
  ];
  const keys = Object.keys(value);
  if (keys.length === 0 || !keys.every((key) => allowedKeys.includes(key))) return null;

  const patch: UpdateContentPatchInput = {};
  if (hasOwn(value, "title")) {
    if (typeof value.title !== "string") return null;
    patch.title = value.title;
  }
  if (hasOwn(value, "bodyMarkdown")) {
    if (typeof value.bodyMarkdown !== "string") return null;
    patch.bodyMarkdown = value.bodyMarkdown;
  }
  if (hasOwn(value, "sourceLinks")) {
    const sourceLinks = parseSourceLinks(value.sourceLinks);
    if (sourceLinks === null) return null;
    patch.sourceLinks = sourceLinks;
  }
  if (hasOwn(value, "references")) {
    const references = parseReferences(value.references);
    if (references === null) return null;
    patch.references = references;
  }
  if (hasOwn(value, "additionalCommunityIds")) {
    const additionalCommunityIds = parseStringArray(value.additionalCommunityIds);
    if (additionalCommunityIds === null) return null;
    patch.additionalCommunityIds = additionalCommunityIds;
  }
  if (hasOwn(value, "symbols")) {
    const symbols = parseStringArray(value.symbols);
    if (symbols === null) return null;
    patch.symbols = symbols;
  }
  if (hasOwn(value, "topics")) {
    const topics = parseStringArray(value.topics);
    if (topics === null) return null;
    patch.topics = topics;
  }
  return patch;
}

function parseFrozenUpdateBaseline(value: unknown): FrozenUpdateContentBaseline | null {
  if (
    !isPlainRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "additionalCommunityIds,bodyMarkdown,contentKind,primaryCommunityId,resourceVersion,revisionId,title" ||
    !Array.isArray(value.additionalCommunityIds) ||
    !value.additionalCommunityIds.every(
      (communityId): communityId is string => typeof communityId === "string",
    ) ||
    typeof value.bodyMarkdown !== "string" ||
    (value.contentKind !== "post" && value.contentKind !== "reply") ||
    typeof value.primaryCommunityId !== "string" ||
    typeof value.resourceVersion !== "number" ||
    typeof value.revisionId !== "string" ||
    (value.title !== null && typeof value.title !== "string")
  ) {
    return null;
  }
  return {
    additionalCommunityIds: value.additionalCommunityIds,
    bodyMarkdown: value.bodyMarkdown,
    contentKind: value.contentKind,
    primaryCommunityId: value.primaryCommunityId,
    resourceVersion: value.resourceVersion,
    revisionId: value.revisionId,
    title: value.title,
  };
}

function parseNormalizedCommand(value: unknown): NormalizedResearchCommand {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PendingCommandCodecError("PENDING_COMMAND_PAYLOAD_INVALID");
  }
  const command = value as Record<string, unknown>;
  const frozenMentionActorIds = hasOwn(command, "frozenMentionActorIds")
    ? parseStringArray(command.frozenMentionActorIds)
    : undefined;
  if (frozenMentionActorIds === null) {
    throw new PendingCommandCodecError("PENDING_COMMAND_PAYLOAD_INVALID");
  }
  const withFrozenMentions = (
    parsed: NormalizedResearchCommand,
  ): NormalizedResearchCommand =>
    frozenMentionActorIds === undefined
      ? parsed
      : freezeResearchCommandMentionActors(parsed, frozenMentionActorIds);

  if (
    command.operation === "create_post" &&
    Object.keys(command).every((key) =>
      [
        "operation",
        "title",
        "bodyMarkdown",
        "primaryCommunityId",
        "additionalCommunityIds",
        "symbols",
        "topics",
        "sourceLinks",
        "references",
        "frozenMentionActorIds",
      ].includes(key),
    ) &&
    typeof command.title === "string" &&
    typeof command.bodyMarkdown === "string" &&
    typeof command.primaryCommunityId === "string"
  ) {
    const additionalCommunityIds = parseStringArray(command.additionalCommunityIds);
    const symbols = parseStringArray(command.symbols);
    const topics = parseStringArray(command.topics);
    const sourceLinks = parseSourceLinks(command.sourceLinks);
    const references = parseReferences(command.references);
    if (additionalCommunityIds && symbols && topics && sourceLinks && references) {
      return withFrozenMentions(
        normalizeCreatePostCommand({
          title: command.title,
          bodyMarkdown: command.bodyMarkdown,
          primaryCommunityId: command.primaryCommunityId,
          additionalCommunityIds,
          symbols,
          topics,
          sourceLinks,
          references,
        }),
      );
    }
  }

  if (
    command.operation === "reply_to_content" &&
    Object.keys(command).every((key) =>
      [
        "operation",
        "parentContentId",
        "bodyMarkdown",
        "symbols",
        "topics",
        "sourceLinks",
        "references",
        "frozenMentionActorIds",
      ].includes(key),
    ) &&
    typeof command.parentContentId === "string" &&
    typeof command.bodyMarkdown === "string"
  ) {
    const symbols = parseStringArray(command.symbols);
    const topics = parseStringArray(command.topics);
    const sourceLinks = parseSourceLinks(command.sourceLinks);
    const references = parseReferences(command.references);
    if (symbols && topics && sourceLinks && references) {
      return withFrozenMentions(
        normalizeReplyCommand({
          parentContentId: command.parentContentId,
          bodyMarkdown: command.bodyMarkdown,
          symbols,
          topics,
          sourceLinks,
          references,
        }),
      );
    }
  }

  if (
    command.operation === "update_content" &&
    Object.keys(command).every((key) =>
      [
        "operation",
        "contentId",
        "expectedVersion",
        "patch",
        "editSummary",
        "frozenMentionActorIds",
        "frozenUpdateBaseline",
      ].includes(key),
    ) &&
    typeof command.contentId === "string" &&
    typeof command.expectedVersion === "number" &&
    (command.editSummary === undefined || typeof command.editSummary === "string")
  ) {
    const patch = parseUpdatePatch(command.patch);
    const baseline = parseFrozenUpdateBaseline(command.frozenUpdateBaseline);
    if (patch !== null && baseline !== null) {
      return withFrozenMentions(
        freezeUpdateContentBaseline(
          normalizeUpdateContentCommand({
            contentId: command.contentId,
            expectedVersion: command.expectedVersion,
            patch,
            ...(command.editSummary === undefined
              ? {}
              : { editSummary: command.editSummary }),
          }),
          baseline,
        ),
      );
    }
  }

  if (
    command.operation === "delete_content" &&
    Object.keys(command).every((key) =>
      ["operation", "contentId", "expectedVersion", "mode", "reason"].includes(key),
    ) &&
    typeof command.contentId === "string" &&
    typeof command.expectedVersion === "number" &&
    (command.mode === "soft" || command.mode === "permanent") &&
    (command.reason === undefined || typeof command.reason === "string")
  ) {
    return normalizeDeleteContentCommand({
      contentId: command.contentId,
      expectedVersion: command.expectedVersion,
      mode: command.mode,
      ...(command.reason === undefined ? {} : { reason: command.reason }),
    });
  }

  throw new PendingCommandCodecError("PENDING_COMMAND_PAYLOAD_INVALID");
}

function digestMatches(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

export function encryptPendingCommand(
  command: NormalizedResearchCommand,
  authority: PendingCommandAuthority,
  keyRing: PendingCommandKeyRing,
): EncryptedPendingCommand {
  if (
    authority.operation !== command.operation ||
    !digestMatches(authority.inputDigest, digestResearchCommand(command))
  ) {
    throw new PendingCommandCodecError("PENDING_COMMAND_PAYLOAD_INVALID");
  }
  const keyVersion = keyRing.currentVersion;
  const key = keyForVersion(keyRing, keyVersion);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce, {
    authTagLength: AUTH_TAG_BYTES,
  });
  cipher.setAAD(canonicalAuthority(authority));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(command), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  key.fill(0);
  return {
    ciphertext,
    nonce,
    keyVersion,
    formatVersion: FORMAT_VERSION,
  };
}

export function decryptPendingCommand(
  encrypted: EncryptedPendingCommand,
  authority: PendingCommandAuthority,
  keyRing: PendingCommandKeyRing,
): NormalizedResearchCommand {
  if (
    encrypted.formatVersion !== FORMAT_VERSION ||
    encrypted.nonce.byteLength !== NONCE_BYTES ||
    encrypted.ciphertext.byteLength <= AUTH_TAG_BYTES
  ) {
    throw new PendingCommandCodecError("PENDING_COMMAND_FORMAT_UNSUPPORTED");
  }
  const key = keyForVersion(keyRing, encrypted.keyVersion);
  const payload = encrypted.ciphertext.subarray(
    0,
    encrypted.ciphertext.byteLength - AUTH_TAG_BYTES,
  );
  const authTag = encrypted.ciphertext.subarray(
    encrypted.ciphertext.byteLength - AUTH_TAG_BYTES,
  );

  try {
    const decipher = createDecipheriv(ALGORITHM, key, encrypted.nonce, {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAAD(canonicalAuthority(authority));
    decipher.setAuthTag(authTag);
    const decoded = Buffer.concat([decipher.update(payload), decipher.final()]).toString(
      "utf8",
    );
    const command = parseNormalizedCommand(JSON.parse(decoded) as unknown);
    if (
      authority.operation !== command.operation ||
      !digestMatches(authority.inputDigest, digestResearchCommand(command))
    ) {
      throw new PendingCommandCodecError("PENDING_COMMAND_PAYLOAD_INVALID");
    }
    return command;
  } catch (error) {
    if (error instanceof PendingCommandCodecError) throw error;
    throw new PendingCommandCodecError("PENDING_COMMAND_AUTHENTICATION_FAILED");
  } finally {
    key.fill(0);
  }
}
