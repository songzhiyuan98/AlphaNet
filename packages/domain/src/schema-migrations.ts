/**
 * Runtime schema gates use the exact published migration bytes. This prevents a
 * newer API or Worker from silently starting against a same-named but
 * semantically different local migration.
 */
export const PENDING_ACTION_EXECUTION_MIGRATION_CHECKSUM =
  "b7b6be5369745550c3483e1384e56fe8c6764c198872b2698f8308a85141deff";
