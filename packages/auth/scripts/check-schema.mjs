import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import pg from "pg";

const workspace = process.cwd();
const expectedPath = resolve(workspace, "schema/better-auth-1.6.23.sql");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "alphanet-auth-schema-"));
const actualPath = join(temporaryDirectory, "generated.sql");
const generationSchema = `auth_schema_check_${randomBytes(8).toString("hex")}`;
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://alphanet:alphanet_local_only@127.0.0.1:5432/alphanet";
const pool = new pg.Pool({
  application_name: "alphanet-auth-schema-check",
  connectionString: databaseUrl,
  max: 1,
});

try {
  await pool.query(`create schema "${generationSchema}"`);
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "auth",
      "generate",
      "--config",
      "src/schema-config.ts",
      "--output",
      actualPath,
      "--yes",
    ],
    {
      cwd: workspace,
      encoding: "utf8",
      env: {
        ...process.env,
        AUTH_SCHEMA_GENERATION_SCHEMA: generationSchema,
        DATABASE_URL: databaseUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || "Schema generation failed.\n");
    process.exitCode = result.status ?? 1;
  } else {
    const [expected, actual] = await Promise.all([
      readFile(expectedPath, "utf8"),
      readFile(actualPath, "utf8"),
    ]);

    // Editors normalize the committed file to one final newline while the
    // pinned CLI currently emits none. Only that EOF representation is ignored.
    if (expected.trimEnd() !== actual.trimEnd()) {
      process.stderr.write(
        "Better Auth schema drift detected. Regenerate with auth@1.6.23, review the SQL, and add a forward AlphaNet migration.\n",
      );
      process.exitCode = 1;
    } else {
      process.stdout.write("Better Auth 1.6.23 schema snapshot is current.\n");
    }
  }
} finally {
  await pool
    .query(`drop schema if exists "${generationSchema}" cascade`)
    .catch(() => undefined);
  await pool.end().catch(() => undefined);
  await rm(temporaryDirectory, { force: true, recursive: true });
}
