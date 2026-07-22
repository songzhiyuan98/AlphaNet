import { timingSafeEqual } from "node:crypto";

import type { McpActorAssertionKeyRing } from "./mcp-actor-context.js";

export interface McpActorPreviousKeyConfiguration {
  key: Uint8Array;
  verificationExpiresAt: Date;
}

export interface McpActorKeyRingConfiguration {
  currentKey: Uint8Array;
  currentVersion: number;
  previousKeys?: Readonly<Record<number, McpActorPreviousKeyConfiguration>>;
}

function invalid(): never {
  throw new Error("Invalid MCP ActorContext key ring configuration");
}

function copyKey(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 32 || value.byteLength > 128) {
    return invalid();
  }
  return Uint8Array.from(value);
}

export function createMcpActorAssertionKeyRing(
  configuration: McpActorKeyRingConfiguration,
): McpActorAssertionKeyRing {
  if (
    !Number.isSafeInteger(configuration.currentVersion) ||
    configuration.currentVersion < 1 ||
    configuration.currentVersion > 32_767
  ) {
    return invalid();
  }

  const entries: Record<number, { key: Uint8Array; verificationExpiresAt: Date | null }> =
    {};
  const material: Uint8Array[] = [];
  const addKey = (
    version: number,
    key: Uint8Array,
    verificationExpiresAt: Date | null,
  ): void => {
    if (
      !Number.isSafeInteger(version) ||
      version < 1 ||
      version > 32_767 ||
      Object.hasOwn(entries, version)
    ) {
      return invalid();
    }
    const copy = copyKey(key);
    if (
      material.some(
        (existing) =>
          existing.byteLength === copy.byteLength && timingSafeEqual(existing, copy),
      )
    ) {
      return invalid();
    }
    const cutoff =
      verificationExpiresAt === null ? null : new Date(verificationExpiresAt.valueOf());
    if (
      cutoff !== null &&
      (!(verificationExpiresAt instanceof Date) || !Number.isFinite(cutoff.valueOf()))
    ) {
      return invalid();
    }
    material.push(copy);
    entries[version] = Object.freeze({
      key: copy,
      verificationExpiresAt: cutoff,
    });
  };

  addKey(configuration.currentVersion, configuration.currentKey, null);
  for (const [rawVersion, previous] of Object.entries(configuration.previousKeys ?? {})) {
    const version = Number(rawVersion);
    if (version === configuration.currentVersion || !previous) {
      return invalid();
    }
    addKey(version, previous.key, previous.verificationExpiresAt);
  }

  return Object.freeze({
    currentVersion: configuration.currentVersion,
    keys: Object.freeze(entries),
  });
}
