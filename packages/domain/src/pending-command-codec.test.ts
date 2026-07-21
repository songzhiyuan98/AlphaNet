import { randomBytes, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  decryptPendingCommand,
  encryptPendingCommand,
  PendingCommandCodecError,
  type PendingCommandAuthority,
} from "./pending-command-codec.js";
import {
  digestResearchCommand,
  freezeResearchCommandMentionActors,
  freezeUpdateContentBaseline,
  normalizeCreatePostCommand,
  normalizeUpdateContentCommand,
} from "./research-command.js";

const keyV1 = randomBytes(32);
const keyV2 = randomBytes(32);
const command = normalizeCreatePostCommand({
  title: "AMD data-center scenarios",
  bodyMarkdown: "## Base case\n\nRevenue grows 18%.",
  primaryCommunityId: randomUUID(),
  symbols: ["AMD"],
  topics: ["scenario-analysis"],
  sourceLinks: [{ url: "https://ir.amd.com/example" }],
});
const authority: PendingCommandAuthority = {
  actionId: randomUUID(),
  ownerId: randomUUID(),
  agentId: randomUUID(),
  credentialId: randomUUID(),
  operation: command.operation,
  inputDigest: digestResearchCommand(command),
};

describe("PendingAction frozen command codec", () => {
  it("round-trips a normalized command with authenticated authority context", () => {
    const encrypted = encryptPendingCommand(command, authority, {
      currentVersion: 2,
      keys: { 1: keyV1, 2: keyV2 },
    });

    expect(encrypted.ciphertext.equals(Buffer.from(JSON.stringify(command)))).toBe(false);
    expect(encrypted.ciphertext.byteLength).toBeGreaterThan(16);
    expect(encrypted.nonce).toHaveLength(12);
    expect(encrypted.keyVersion).toBe(2);
    expect(encrypted.formatVersion).toBe(1);
    expect(
      decryptPendingCommand(encrypted, authority, {
        currentVersion: 2,
        keys: { 1: keyV1, 2: keyV2 },
      }),
    ).toEqual(command);
  });

  it("keeps old commands decryptable while writes use the current key version", () => {
    const encrypted = encryptPendingCommand(command, authority, {
      currentVersion: 1,
      keys: { 1: keyV1 },
    });

    expect(
      decryptPendingCommand(encrypted, authority, {
        currentVersion: 2,
        keys: { 1: keyV1, 2: keyV2 },
      }),
    ).toEqual(command);
    expect(
      encryptPendingCommand(command, authority, {
        currentVersion: 2,
        keys: { 1: keyV1, 2: keyV2 },
      }).keyVersion,
    ).toBe(2);
  });

  it("rejects ciphertext tampering and authority-row swapping", () => {
    const encrypted = encryptPendingCommand(command, authority, {
      currentVersion: 1,
      keys: { 1: keyV1 },
    });
    const tampered = {
      ...encrypted,
      ciphertext: Buffer.from(encrypted.ciphertext),
    };
    tampered.ciphertext[0] = tampered.ciphertext[0]! ^ 1;

    expect(() =>
      decryptPendingCommand(tampered, authority, {
        currentVersion: 1,
        keys: { 1: keyV1 },
      }),
    ).toThrow(PendingCommandCodecError);
    expect(() =>
      decryptPendingCommand(
        encrypted,
        { ...authority, actionId: randomUUID() },
        {
          currentVersion: 1,
          keys: { 1: keyV1 },
        },
      ),
    ).toThrow(PendingCommandCodecError);
  });

  it("rejects missing and malformed key-ring material without exposing plaintext", () => {
    expect(() =>
      encryptPendingCommand(command, authority, {
        currentVersion: 3,
        keys: { 3: randomBytes(31) },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<PendingCommandCodecError>>({
        code: "PENDING_COMMAND_KEY_INVALID",
      }),
    );
  });

  it("round-trips an update command without collapsing omitted and cleared fields", () => {
    const baselineCommunityId = randomUUID();
    const updateCommand = freezeResearchCommandMentionActors(
      freezeUpdateContentBaseline(
        normalizeUpdateContentCommand({
          contentId: randomUUID(),
          expectedVersion: 4,
          patch: {
            bodyMarkdown: "Revised research body",
            sourceLinks: [],
            topics: [],
          },
          editSummary: "Remove stale sources",
        }),
        {
          additionalCommunityIds: [],
          bodyMarkdown: "Original research body",
          contentKind: "post",
          primaryCommunityId: baselineCommunityId,
          resourceVersion: 4,
          revisionId: randomUUID(),
          title: "Original research title",
        },
      ),
      [randomUUID()],
    );
    const updateAuthority: PendingCommandAuthority = {
      ...authority,
      actionId: randomUUID(),
      operation: updateCommand.operation,
      inputDigest: digestResearchCommand(updateCommand),
    };
    const encrypted = encryptPendingCommand(updateCommand, updateAuthority, {
      currentVersion: 2,
      keys: { 1: keyV1, 2: keyV2 },
    });

    expect(
      decryptPendingCommand(encrypted, updateAuthority, {
        currentVersion: 2,
        keys: { 1: keyV1, 2: keyV2 },
      }),
    ).toEqual(updateCommand);
  });
});
