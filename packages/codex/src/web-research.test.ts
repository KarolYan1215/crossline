import { expect, test } from "vitest";
import { webResearchBlocker } from "./index";

test("web research is available when the host program sits beside the runtime", () => {
  const env = { CROSSLINE_CODEX_PATH: "C:\\codex\\codex.exe" };
  expect(webResearchBlocker(env, (file) => file === "C:\\codex\\codex-code-mode-host.exe", "win32")).toBeUndefined();
});

test("a missing host is named with the exact path it was expected at", () => {
  const env = { CROSSLINE_CODEX_PATH: "C:\\codex\\codex.exe" };
  const blocker = webResearchBlocker(env, () => false, "win32");
  expect(blocker?.code).toBe("WEB_RESEARCH_HOST_MISSING");
  expect(blocker?.message).toContain("codex-code-mode-host.exe");
  expect(blocker?.message).toContain("C:\\codex");
});
