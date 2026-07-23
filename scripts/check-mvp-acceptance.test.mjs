import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildAcceptanceReport,
  classifyTraceabilityStatus,
  extractAcceptanceIds,
  extractTraceabilityRows,
} from "./check-mvp-acceptance.mjs";

const manifest = {
  schema_version: "1",
  acceptance_source: "acceptance.md",
  traceability_source: "traceability.md",
  source_acceptance_count: 2,
  supplemental_acceptance_ids: ["AC-ST-04"],
  acceptance_release_gates: {
    "AC-ID-02": ["golden_path"],
  },
  global_release_gates: [
    {
      id: "golden_path",
      class: "release_candidate",
      description: "Two-owner release path.",
    },
  ],
};

const acceptanceMarkdown = `
### AC-ID-01：Registration
### AC-ID-02：Restriction
`;

const traceabilityMarkdown = `
| AC | Evidence | Status |
|---|---|---|
| AC-ID-01 | \`tests/a.test.ts\` | 工程已验证 |
| AC-ID-02 | \`tests/b.test.ts\` | 实现完成，待发布验收 |
| AC-ST-04 | \`tests/c.test.ts\` | 工程已验证 |
`;

test("extracts exact acceptance headings and traceability rows", () => {
  assert.deepEqual(extractAcceptanceIds(acceptanceMarkdown), ["AC-ID-01", "AC-ID-02"]);
  assert.deepEqual(
    extractTraceabilityRows(traceabilityMarkdown).map(({ id, status_class }) => ({
      id,
      status_class,
    })),
    [
      { id: "AC-ID-01", status_class: "repository_verified" },
      { id: "AC-ID-02", status_class: "release_evidence_required" },
      { id: "AC-ST-04", status_class: "repository_verified" },
    ],
  );
});

test("builds a conservative report with source and supplemental acceptance separated", () => {
  const report = buildAcceptanceReport({
    acceptanceMarkdown,
    manifest,
    traceabilityMarkdown,
  });

  assert.equal(report.source_acceptance_count, 2);
  assert.equal(report.supplemental_acceptance_count, 1);
  assert.equal(report.release_decision, "NO_GO_UNTIL_RUNTIME_EVIDENCE");
  assert.deepEqual(report.counts, {
    approved_difference: 0,
    release_evidence_required: 1,
    repository_verified: 2,
  });
  assert.deepEqual(
    report.requirements.find(({ id }) => id === "AC-ID-02")?.release_gates,
    ["golden_path"],
  );
});

test("rejects missing, duplicate, unknown and unmapped acceptance evidence", () => {
  assert.throws(
    () =>
      buildAcceptanceReport({
        acceptanceMarkdown,
        manifest,
        traceabilityMarkdown: traceabilityMarkdown.replace(
          "| AC-ID-01 | `tests/a.test.ts` | 工程已验证 |\n",
          "",
        ),
      }),
    /missing AC-ID-01/u,
  );

  assert.throws(
    () =>
      buildAcceptanceReport({
        acceptanceMarkdown,
        manifest,
        traceabilityMarkdown: `${traceabilityMarkdown}| AC-ID-01 | evidence | 工程已验证 |\n`,
      }),
    /duplicate AC-ID-01/u,
  );

  assert.throws(
    () =>
      buildAcceptanceReport({
        acceptanceMarkdown,
        manifest,
        traceabilityMarkdown: `${traceabilityMarkdown}| AC-XX-01 | evidence | 工程已验证 |\n`,
      }),
    /unknown AC-XX-01/u,
  );

  assert.throws(
    () =>
      buildAcceptanceReport({
        acceptanceMarkdown,
        manifest: { ...manifest, acceptance_release_gates: {} },
        traceabilityMarkdown,
      }),
    /AC-ID-02 requires an explicit release gate/u,
  );
});

test("rejects unsupported traceability status instead of treating it as passing", () => {
  assert.equal(
    classifyTraceabilityStatus("工程已验证（私有完整链）"),
    "repository_verified",
  );
  assert.equal(
    classifyTraceabilityStatus("产品批准差异：需修订原 AC"),
    "approved_difference",
  );
  assert.throws(() => classifyTraceabilityStatus("大概完成"), /Unsupported/u);
});
