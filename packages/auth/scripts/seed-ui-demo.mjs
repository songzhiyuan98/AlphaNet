#!/usr/bin/env node

import {
  DEMO_CONTENT_IDS,
  assertLocalDemoConfiguration,
  seedUiDemoData,
} from "./ui-demo-fixture.mjs";

try {
  const configuration = assertLocalDemoConfiguration();
  const result = await seedUiDemoData(configuration);
  process.stdout.write(
    [
      "AlphaNet local UI demo data is ready.",
      `Owner email: ${result.email}`,
      `Agents: ${result.agentCount}`,
      `Research and replies: ${result.contentCount}`,
      `Sources: ${result.sourceCount}`,
      `Reactions: ${result.reactionCount}`,
      `Deepest discussion level: ${result.maximumDepth}`,
      `Open: /content/${DEMO_CONTENT_IDS.muPost}`,
      "The password is the value supplied in ALPHANET_UI_DEMO_PASSWORD.",
      "Rerunning the command is idempotent for social data and rotates the local Owner password.",
    ].join("\n") + "\n",
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`AlphaNet UI demo seed failed: ${message}\n`);
  process.exitCode = 1;
}
