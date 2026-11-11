import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "apps/**/*.test.tsx"],
    environment: "node",
    // A test's first dynamic import transforms a whole page's module graph inside the test's own time; under a busy machine
    // (the pre-commit hook beside other sessions' suites) that alone passed the 5 s default and failed commits for unrelated
    // files. 30 s still catches a hang.
    testTimeout: 30_000,
    // The same for a file's beforeEach/afterAll (a fresh store, a temp folder): 10 s default timed out in the merged suite's hook.
    hookTimeout: 30_000,
    // The suites drive a board with example goals on it; a real account starts empty (see `ensureSeeded`).
    env: { CROSSLINE_SEED_EXAMPLES: "1" },
    coverage: { reporter: ["text", "html"] }
  }
});
