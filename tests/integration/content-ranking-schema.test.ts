import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { afterAll, describe, expect, it } from "vitest";

import {
  closeDependencies,
  createPostgresDependency,
  type HealthDependency,
} from "../../packages/database/src/index.js";
import { CONTENT_RANKING_V1_MIGRATION_CHECKSUM } from "../../packages/domain/src/schema-migrations.js";

const databaseUrl = process.env.DATABASE_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";

if (mustRun && !databaseUrl) {
  throw new Error("DATABASE_URL is required when REQUIRE_INTEGRATION_SERVICES=true");
}

const describeRankingSchema = databaseUrl ? describe : describe.skip;
const dependencies: HealthDependency[] = [];
const canonicalTimestamp = "2026-07-21T00:00:00.000Z";

function snapshotId(): string {
  return `crs_${randomUUID().replaceAll("-", "")}`;
}

function candidate(contentId: string = randomUUID(), scoreMicros = 1_000_000) {
  return {
    content_id: contentId,
    created_at: canonicalTimestamp,
    order_at: canonicalTimestamp,
    score_micros: scoreMicros,
  };
}

describeRankingSchema("Content ranking v1 schema", () => {
  const postgres = createPostgresDependency(databaseUrl ?? "");
  dependencies.push(postgres);
  const createdSnapshots = new Set<string>();

  async function storeSnapshot(
    kind: "browse" | "discussion",
    candidates: readonly Record<string, number | string>[],
    options: {
      binding?: Buffer;
      expiresAt?: Date;
      id?: string;
    } = {},
  ): Promise<boolean> {
    const id = options.id ?? snapshotId();
    createdSnapshots.add(id);
    const rows = await postgres.sql<{ stored: boolean }[]>`
      select system.store_content_ranking_candidate_snapshot(
        ${id},
        ${options.binding ?? randomBytes(32)},
        ${kind},
        ${postgres.sql.json(candidates)},
        ${options.expiresAt ?? new Date(Date.now() + 300_000)}
      ) as stored
    `;
    return rows[0]?.stored === true;
  }

  afterAll(async () => {
    try {
      for (const id of createdSnapshots) {
        await postgres.sql`
          delete from system.content_ranking_candidate_snapshots
          where snapshot_id = ${id}
        `;
      }
    } finally {
      await closeDependencies(dependencies);
    }
  });

  it("records migration 000017 and installs the hardened snapshot boundary", async () => {
    const migration = await readFile(
      `${process.cwd()}/db/migrations/000017_content_ranking_v1.up.sql`,
    );
    const checksum = createHash("sha256").update(migration).digest("hex");
    expect(checksum).toBe(CONTENT_RANKING_V1_MIGRATION_CHECKSUM);

    const ledger = await postgres.sql<
      { checksum: string; name: string; version: string }[]
    >`
      select version, name, checksum
      from system.schema_migrations
      where version = '000017'
    `;
    expect(ledger).toEqual([{ checksum, name: "content_ranking_v1", version: "000017" }]);

    const shape = await postgres.sql<
      { constraints: number; hardened_functions: number; indexes: number }[]
    >`
      select
        (
          select count(*)::integer
          from pg_constraint
          where convalidated
            and conname in (
              'content_ranking_candidate_snapshots_id',
              'content_ranking_candidate_snapshots_binding',
              'content_ranking_candidate_snapshots_kind',
              'content_ranking_candidate_snapshots_candidates',
              'content_ranking_candidate_snapshots_retention'
            )
        ) as constraints,
        (
          select count(*)::integer
          from pg_class
          where oid = any(array[
            to_regclass('system.content_ranking_candidate_snapshots_expiry_idx'),
            to_regclass('platform.reactions_ranking_recent_idx'),
            to_regclass('platform.content_items_ranking_reply_recent_idx')
          ]::oid[])
        ) as indexes,
        (
          select count(*)::integer
          from pg_proc as routine
          join pg_namespace as namespace on namespace.oid = routine.pronamespace
          where namespace.nspname = 'system'
            and routine.proname in (
              'store_content_ranking_candidate_snapshot',
              'purge_expired_content_ranking_candidate_snapshots'
            )
            and routine.prosecdef
            and 'search_path=pg_catalog' = any(routine.proconfig)
            and not exists (
              select 1
              from aclexplode(
                coalesce(routine.proacl, acldefault('f', routine.proowner))
              ) as privilege
              where privilege.grantee = 0
                and privilege.privilege_type = 'EXECUTE'
            )
        ) as hardened_functions
    `;
    expect(shape).toEqual([{ constraints: 5, hardened_functions: 2, indexes: 3 }]);
  });

  it("stores only canonical controlled candidate fields and retries immutably", async () => {
    const id = snapshotId();
    const binding = randomBytes(32);
    const expiresAt = new Date(Date.now() + 300_000);
    const contentId = randomUUID();
    const candidates = [candidate(contentId)];

    await expect(
      storeSnapshot("browse", candidates, { binding, expiresAt, id }),
    ).resolves.toBe(true);
    await expect(
      storeSnapshot("browse", candidates, { binding, expiresAt, id }),
    ).resolves.toBe(true);

    const stored = await postgres.sql<
      { candidates: unknown; payload: string; snapshot_kind: string }[]
    >`
      select candidates, snapshot_kind, candidates::text as payload
      from system.content_ranking_candidate_snapshots
      where snapshot_id = ${id}
    `;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ candidates, snapshot_kind: "browse" });
    expect(stored[0]?.payload).not.toMatch(
      /title|body|query|prompt|snippet|owner|credential/iu,
    );

    await expect(
      storeSnapshot("browse", [candidate(contentId, 2_000_000)], {
        binding,
        expiresAt,
        id,
      }),
    ).rejects.toThrow(/identity conflict/iu);
    await expect(
      storeSnapshot("discussion", candidates, {
        binding,
        expiresAt,
        id,
      }),
    ).rejects.toThrow(/identity conflict/iu);
    await expect(
      storeSnapshot("browse", candidates, {
        binding: randomBytes(32),
        expiresAt,
        id,
      }),
    ).rejects.toThrow(/identity conflict/iu);
  });

  it("enforces browse and discussion horizons independently", async () => {
    const fiveHundredOne = Array.from({ length: 501 }, () => candidate());
    await expect(storeSnapshot("browse", fiveHundredOne)).rejects.toThrow(
      /Invalid Content ranking candidate snapshot/iu,
    );
    await expect(storeSnapshot("discussion", fiveHundredOne)).resolves.toBe(true);

    const twoThousandOne = Array.from({ length: 2_001 }, () => candidate());
    await expect(storeSnapshot("discussion", twoThousandOne)).rejects.toThrow(
      /Invalid Content ranking candidate snapshot/iu,
    );
  });

  it("rejects extra keys, duplicates, unsafe integers, and noncanonical facts", async () => {
    const duplicateId = randomUUID();
    const invalidPayloads: readonly Record<string, number | string>[][] = [
      [{ ...candidate(), title: "UGC must not enter the snapshot" }],
      [candidate("not-a-uuid")],
      [candidate(randomUUID(), 9_007_199_254_740_992)],
      [candidate(duplicateId), candidate(duplicateId)],
      [
        {
          ...candidate(),
          created_at: "2026-07-21T00:00:00Z",
        },
      ],
      [
        {
          ...candidate(),
          order_at: "2026-02-31T00:00:00.000Z",
        },
      ],
    ];

    for (const payload of invalidPayloads) {
      await expect(storeSnapshot("browse", payload)).rejects.toThrow();
    }

    await expect(
      storeSnapshot("browse", [candidate()], {
        expiresAt: new Date(Date.now() + 3_600_100),
      }),
    ).rejects.toThrow(/Invalid Content ranking candidate snapshot/iu);
  });

  it("purges expired rows in a bounded deterministic batch", async () => {
    const first = snapshotId();
    const second = snapshotId();
    createdSnapshots.add(first);
    createdSnapshots.add(second);
    const payload = [candidate()];

    await postgres.sql`
      insert into system.content_ranking_candidate_snapshots (
        snapshot_id,
        binding_hmac,
        snapshot_kind,
        candidates,
        created_at,
        expires_at
      )
      values
        (
          ${first},
          ${randomBytes(32)},
          'browse',
          ${postgres.sql.json(payload)},
          '2020-01-01T00:00:00.000Z'::timestamptz,
          '2020-01-01T00:01:00.000Z'::timestamptz
        ),
        (
          ${second},
          ${randomBytes(32)},
          'browse',
          ${postgres.sql.json(payload)},
          '2020-01-01T00:02:00.000Z'::timestamptz,
          '2020-01-01T00:03:00.000Z'::timestamptz
        )
    `;

    const purged = await postgres.sql<{ count: number }[]>`
      select system.purge_expired_content_ranking_candidate_snapshots(1) as count
    `;
    expect(purged).toEqual([{ count: 1 }]);
    const remaining = await postgres.sql<{ count: number }[]>`
      select count(*)::integer as count
      from system.content_ranking_candidate_snapshots
      where snapshot_id in (${first}, ${second})
    `;
    expect(remaining).toEqual([{ count: 1 }]);

    await expect(
      postgres.sql`
        select system.purge_expired_content_ranking_candidate_snapshots(0)
      `,
    ).rejects.toThrow(/batch size/iu);
  });
});
