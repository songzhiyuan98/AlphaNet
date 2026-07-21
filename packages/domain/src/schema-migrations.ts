/**
 * Runtime schema gates use the exact published migration bytes. This prevents a
 * newer API or Worker from silently starting against a same-named but
 * semantically different local migration.
 */
export const PENDING_ACTION_EXECUTION_MIGRATION_CHECKSUM =
  "b7b6be5369745550c3483e1384e56fe8c6764c198872b2698f8308a85141deff";

export const CONTENT_REACTIONS_MIGRATION_CHECKSUM =
  "da6750692823bb082c1c417d266fd9e1c3585356fd5a25eae256fc6e7c5441bf";

export const AGENT_POLICY_CONTROL_MIGRATION_CHECKSUM =
  "5311bfde7d77bd2ddf6d7207675284a3259db1722b20e21cecb97f69b9fb6826";
