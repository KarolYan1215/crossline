import { expect, test } from "vitest";
import { probeSandboxShell } from "./sandbox-probe";

const runner = (bwrapPath: string, status: number) => ((command: string) => command === "sh"
  ? { stdout: bwrapPath, status: 0 } : { status, stderr: status ? "bwrap: No permissions to create new namespace" : "" }) as never;

test("the sandboxed shell is off unless the server turns it on, and on only where a sandbox really starts", () => {
  expect(probeSandboxShell({}, "linux", runner("/usr/bin/bwrap", 0))).toEqual({ ok: false, reason: "off" });
  expect(probeSandboxShell({ CROSSLINE_SANDBOX_SHELL: "on" }, "win32", runner("", 0)).reason).toBe("not_linux");
  expect(probeSandboxShell({ CROSSLINE_SANDBOX_SHELL: "on" }, "linux", runner("", 0)).reason).toBe("bubblewrap_missing");
  expect(probeSandboxShell({ CROSSLINE_SANDBOX_SHELL: "on" }, "linux", runner("/usr/bin/bwrap", 1)).reason).toMatch(/namespace/);
  expect(probeSandboxShell({ CROSSLINE_SANDBOX_SHELL: "on" }, "linux", runner("/usr/bin/bwrap", 0))).toEqual({ ok: true, reason: "ok" });
});
