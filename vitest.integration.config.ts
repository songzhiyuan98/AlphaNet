import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
