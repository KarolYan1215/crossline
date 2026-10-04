import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "apps/**/*.test.tsx"],
    environment: "node",
    // The suites drive a board with example goals on it; a real account starts empty (see `ensureSeeded`).
    env: { CROSSLINE_SEED_EXAMPLES: "1" },
    coverage: { reporter: ["text", "html"] }
  }
});
