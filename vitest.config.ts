import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000,
    hookTimeout: 20000,
    reporters: ["default"],
    // Live integration tests all drive the *same* single Ollama instance. Run
    // test files in parallel and they queue behind one another until a
    // 300s test timeout fires — a flake that has nothing to do with the code
    // under test (Phase 5 added a fifth live test and made it reproducible).
    // Serialising files costs a few seconds on the unit suite and makes the
    // suite deterministic. This is a fix to the test harness, not a skip.
    fileParallelism: false,
  },
});
