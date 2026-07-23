import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { format, resolveConfig } from "prettier";

import { ALPHANET_OPENAPI_DOCUMENT } from "../packages/contracts/src/openapi.ts";

const target = resolve(process.cwd(), "../../docs/api/openapi.v1.json");
const check = process.argv.includes("--check");

async function main() {
  const prettierConfig = (await resolveConfig(target)) ?? {};
  const expected = await format(JSON.stringify(ALPHANET_OPENAPI_DOCUMENT), {
    ...prettierConfig,
    filepath: target,
  });
  if (check) {
    let actual;
    try {
      actual = await readFile(target, "utf8");
    } catch (error) {
      console.error(`OpenAPI artifact is missing at ${target}. Run pnpm openapi:write.`);
      throw error;
    }
    if (actual !== expected) {
      console.error(
        "docs/api/openapi.v1.json is stale. Run pnpm openapi:write and commit the result.",
      );
      process.exitCode = 1;
    } else {
      console.log("OpenAPI artifact matches the shared contract.");
    }
  } else {
    await writeFile(target, expected, "utf8");
    console.log(`Wrote ${target}`);
  }
}

void main();
