import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const inputPath =
  process.env.WEB_COMPATIBILITY_REPORT_PATH ??
  "artifacts/release/web-compatibility-playwright.json";
const outputPath =
  process.env.WEB_COMPATIBILITY_EVIDENCE_PATH ??
  "artifacts/release/web-compatibility.json";
const releaseSha = process.env.RELEASE_SHA?.trim() ?? "";
const sourceRunId = process.env.SOURCE_RUN_ID?.trim() ?? "";
const requiredProjects = ["chrome", "edge", "firefox", "mobile-safari", "safari"];

if (!/^[0-9a-f]{40}$/u.test(releaseSha)) {
  throw new Error("RELEASE_SHA must be a full lowercase commit SHA.");
}
if (!/^[1-9][0-9]*$/u.test(sourceRunId)) {
  throw new Error("SOURCE_RUN_ID must be a positive integer.");
}

const report = JSON.parse(await readFile(inputPath, "utf8"));
if (typeof report !== "object" || report === null || Array.isArray(report)) {
  throw new Error("Playwright report must be a JSON object.");
}

const projectNames = Array.isArray(report.config?.projects)
  ? report.config.projects
      .map((project) => project?.name)
      .filter((name) => typeof name === "string")
      .sort()
  : [];
if (JSON.stringify(projectNames) !== JSON.stringify(requiredProjects)) {
  throw new Error(
    `Playwright report projects must be exactly: ${requiredProjects.join(", ")}.`,
  );
}

const counts = new Map(
  requiredProjects.map((project) => [
    project,
    { expected: 0, skipped: 0, unexpected: 0 },
  ]),
);

function visitSuite(suite) {
  for (const spec of Array.isArray(suite?.specs) ? suite.specs : []) {
    for (const test of Array.isArray(spec?.tests) ? spec.tests : []) {
      const project = test?.projectName;
      const status = test?.status;
      const projectCounts = counts.get(project);
      if (!projectCounts || !["expected", "skipped", "unexpected"].includes(status)) {
        throw new Error("Playwright report contains an unknown project or test status.");
      }
      projectCounts[status] += 1;
    }
  }
  for (const child of Array.isArray(suite?.suites) ? suite.suites : []) {
    visitSuite(child);
  }
}

for (const suite of Array.isArray(report.suites) ? report.suites : []) {
  visitSuite(suite);
}

const projects = requiredProjects.map((project) => ({
  name: project,
  ...counts.get(project),
}));
if (
  projects.some(
    (project) =>
      project.unexpected !== 0 ||
      project.expected < 3 ||
      (project.name === "mobile-safari" ? project.skipped !== 0 : project.skipped !== 1),
  )
) {
  throw new Error("Browser matrix is incomplete or contains an unexpected test result.");
}
if ((report.errors?.length ?? 0) !== 0 || (report.stats?.unexpected ?? 0) !== 0) {
  throw new Error("Playwright report contains suite-level errors.");
}

const evidence = {
  schema_version: "1",
  gate: "web_compatibility",
  release_sha: releaseSha,
  source: {
    provider: "github_actions",
    run_id: sourceRunId,
  },
  result: "pass",
  projects,
  automated_scope: [
    "public discovery",
    "community and discussion navigation",
    "credential-free public search",
    "Owner login and open registration",
    "mobile navigation and horizontal overflow",
  ],
  manual_accessibility_review_required: true,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
