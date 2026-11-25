import { expect, test } from "vitest";
import { PACKAGE_DOMAINS, readWindowsSandbox, SANDBOX_PROFILE, sandboxProfile, WINDOWS_SHELL_PROFILE, windowsShellConfig } from "./agent-mode";
import { appServerLaunchFlags, type CodexRpcBoundary } from "./index";

test("the runtime's own helper folder is read-only inside a writable tmp under a denied state folder", () => {
  const profile = sandboxProfile({ writable: "/data/ai-output/t1", readable: ["/opt/codex"], deny: ["/data", "/state"],
    runtimeTmp: "/state/runtimes/ws1/codex-home/tmp/" }) as Record<string, { filesystem: Record<string, string> }>;
  expect(profile[SANDBOX_PROFILE]!.filesystem).toEqual({
    ":minimal": "read", "/data": "deny", "/state": "deny", "/opt/codex": "read", "/data/ai-output/t1": "write",
    "/state/runtimes/ws1/codex-home/tmp/": "write",
    "/state/runtimes/ws1/codex-home/tmp/arg0-linux": "read", "/state/runtimes/ws1/codex-home/tmp/arg0": "read"
  });
});

test("the owner's Windows shell: reads anywhere but its denies, writes in the task, no network or only the package registries through the proxy", () => {
  const base = { writable: ["C:\\ai\\t1"], deny: ["C:\\Users\\k\\.ssh"], env: { TEMP: "C:\\ai\\t1\\.tmp" } };
  const offline = windowsShellConfig({ ...base, backend: "mxc", egress: "none" });
  expect(offline).toEqual({
    default_permissions: WINDOWS_SHELL_PROFILE, "features.prefer_mxc": true, shell_environment_policy: { set: { TEMP: "C:\\ai\\t1\\.tmp" } },
    permissions: { [WINDOWS_SHELL_PROFILE]: { description: "Crossline owner's shell", network: { enabled: false },
      filesystem: { ":root": "read", "C:\\Users\\k\\.ssh": "deny", "C:\\ai\\t1": "write" } } }
  });
  const packages = windowsShellConfig({ ...base, backend: "elevated", egress: "packages" });
  expect(packages).toMatchObject({ "features.network_proxy": true });
  expect(packages).not.toHaveProperty("features.prefer_mxc");
  expect((packages.permissions as Record<string, { network: unknown }>)[WINDOWS_SHELL_PROFILE]!.network)
    .toEqual({ enabled: true, domains: Object.fromEntries(PACKAGE_DOMAINS.map((domain) => [domain, "allow"])) });
  expect([...PACKAGE_DOMAINS]).toEqual(["pypi.org", "files.pythonhosted.org", "registry.npmjs.org"]);
});

test("the runtime's word on its Windows sandbox: readiness and the configured backend, nothing when it does not answer", async () => {
  const client = (answers: Record<string, unknown>) => ({ onNotification: () => () => {}, request: async (method: string) => {
    if (!(method in answers)) throw new Error(`unknown method ${method}`);
    return answers[method];
  } }) as unknown as CodexRpcBoundary;
  expect(await readWindowsSandbox(client({ "windowsSandbox/readiness": { status: "ready" }, "config/read": { config: {} } }))).toEqual({ readiness: "ready" });
  expect(await readWindowsSandbox(client({ "windowsSandbox/readiness": { status: "ready" }, "config/read": { config: { windows: { sandbox: "elevated" } } } })))
    .toEqual({ readiness: "ready", configured: "elevated" });
  expect(await readWindowsSandbox(client({}))).toBeUndefined();
  const silent = { onNotification: () => () => {}, request: () => new Promise(() => {}) } as unknown as CodexRpcBoundary;
  expect(await readWindowsSandbox(silent, 10)).toBeUndefined();
});

test("on Windows the runtime is launched preferring MXC, so its readiness can say whether MXC is there", () => {
  expect(appServerLaunchFlags("win32")).toEqual(["-c", "features.prefer_mxc=true"]);
  expect(appServerLaunchFlags("linux")).toEqual([]);
});
