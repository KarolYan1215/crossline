import { expect, test } from "vitest";
import { SANDBOX_PROFILE, sandboxProfile } from "./agent-mode";

test("the runtime's own helper folder is read-only inside a writable tmp under a denied state folder", () => {
  const profile = sandboxProfile({ writable: "/data/ai-output/t1", readable: ["/opt/codex"], deny: ["/data", "/state"],
    runtimeTmp: "/state/runtimes/ws1/codex-home/tmp/" }) as Record<string, { filesystem: Record<string, string> }>;
  expect(profile[SANDBOX_PROFILE]!.filesystem).toEqual({
    ":minimal": "read", "/data": "deny", "/state": "deny", "/opt/codex": "read", "/data/ai-output/t1": "write",
    "/state/runtimes/ws1/codex-home/tmp/": "write",
    "/state/runtimes/ws1/codex-home/tmp/arg0-linux": "read", "/state/runtimes/ws1/codex-home/tmp/arg0": "read"
  });
});
