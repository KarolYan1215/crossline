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

test("the worker's seccomp profile adds only what bubblewrap needs to Docker's default", async () => {
  const { readFileSync } = await import("node:fs");
  const profile = JSON.parse(readFileSync(new URL("../../../deploy/server/seccomp-sandbox.json", import.meta.url), "utf8")) as {
    defaultAction: string; syscalls: Array<{ names: string[]; action: string; args?: unknown; includes?: object; excludes?: object }> };
  expect(profile.defaultAction).toBe("SCMP_ACT_ERRNO");
  const always = new Set(profile.syscalls.filter((rule) => rule.action === "SCMP_ACT_ALLOW" && !rule.args && !rule.includes && !rule.excludes)
    .flatMap((rule) => rule.names));
  for (const name of ["clone", "clone3", "unshare", "mount", "umount2", "pivot_root", "setns"]) expect(always.has(name)).toBe(true);
  for (const name of ["bpf", "kexec_load", "init_module", "reboot", "swapon", "ptrace", "keyctl"]) expect(always.has(name)).toBe(false);
});
