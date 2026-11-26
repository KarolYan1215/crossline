import type { CodexRpcBoundary } from "./index";

/**
 * What turns a Skill run into an assistant run: the thread gets a shell, file access and the rest of the runtime's tools, in the
 * task's own directory, and every request the runtime makes to the person (run this command, change these files, call this account
 * tool) is answered here by the guard instead of by a human at a terminal.
 */
export type AgentItem = Record<string, unknown>;
export type AgentMode = {
  /** The task's directory: the thread's working directory and the one place it writes. */
  cwd: string;
  /** Every item the runtime starts or finishes — a command, a file change, an account-tool call, a search — for the audit trail. */
  onItem: (item: AgentItem, phase: "started" | "completed") => void;
  /** The answer to one of the runtime's requests. Throwing refuses it. */
  answer: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>;
  /**
   * Run the shell inside Codex's own Linux sandbox (bubblewrap) instead of with full access (docs/personal-agent.md §8): writes only in
   * `writable`, reads only the system's own folders and `readable`, `deny` unreadable whatever else says, no network. Absent: full access
   * (the machine owner's own computer, behind the guard).
   */
  sandbox?: { writable: string; readable: string[]; deny: string[]; env?: Record<string, string>;
    /**
     * The account's runtime home's `tmp`, where Codex links its own sandbox helper (`tmp/arg0-linux/codex-arg0…/codex-linux-sandbox`).
     * The home lies under a denied folder, and bubblewrap reopens a denied folder only for writable children (a readable one stays
     * behind `--perms 000`), so `tmp` is writable and the helper folders inside it are read-only on top: a command can never replace
     * the helper the runtime starts outside the sandbox (2026-11-05, W-217).
     */
    runtimeTmp?: string };
  /**
   * The runtime's own web search for this thread (docs/plans/harness-1125.md §3): `cached` for a research run, `disabled` for one handed
   * untrusted content. Absent: `live`, as before.
   */
  webSearch?: "live" | "cached" | "disabled";
  /**
   * The machine owner's shell on Windows under a real sandbox (docs/plans/harness-1125.md §9): `mxc` is Codex's MXC backend (no
   * administrator, no sandbox user), `elevated` the legacy one someone already set up. Reads anywhere but `deny`, writes only in
   * `writable`; `egress: "none"` has no network, `packages` reaches only `PACKAGE_DOMAINS` through Codex's managed proxy. Absent: full
   * access behind the guard (the owner's shell on a computer with neither).
   */
  windowsSandbox?: WindowsShellSandbox;
  /**
   * Run before each answer is validated: a run on a compute node copies the files it wrote back to the server here, so the validator's
   * artifact check reads them (docs/compute-node.md P3).
   */
  beforeValidate?: () => Promise<void>;
};

/** The permission profile a sandboxed assistant thread runs under (Codex `[permissions.<id>]`). */
export const SANDBOX_PROFILE = "crossline-task";
export function sandboxProfile(sandbox: NonNullable<AgentMode["sandbox"]>): Record<string, unknown> {
  const filesystem: Record<string, string> = { ":minimal": "read" };
  for (const path of sandbox.deny) filesystem[path] = "deny";
  for (const path of sandbox.readable) filesystem[path] = "read";
  filesystem[sandbox.writable] = "write";
  if (sandbox.runtimeTmp) {
    filesystem[sandbox.runtimeTmp] = "write";
    for (const helper of ["arg0-linux", "arg0"]) filesystem[`${sandbox.runtimeTmp.replace(/\/+$/, "")}/${helper}`] = "read";
  }
  return { [SANDBOX_PROFILE]: { description: "Crossline assistant task", filesystem, network: { enabled: false } } };
}

export type WindowsShellSandbox = { backend: "mxc" | "elevated"; writable: string[]; deny: string[]; egress: "none" | "packages"; env?: Record<string, string> };

/** The permission profile the owner's shell runs under on Windows (Codex `[permissions.<id>]`). */
export const WINDOWS_SHELL_PROFILE = "crossline-shell";
/** The only hosts a run that may install packages reaches (the owner's decision of 2026-11-25, docs/plans/harness-1125.md §9.2). */
export const PACKAGE_DOMAINS = ["pypi.org", "files.pythonhosted.org", "registry.npmjs.org"] as const;
/** Folders under the person's home whose contents the shell never reads: keys, cloud credentials, the person's own Codex, browser profiles. */
export const SHELL_DENIED_IN_HOME = [".ssh", ".aws", ".gnupg", ".kube", ".azure", ".codex", "AppData\\Local\\Google\\Chrome\\User Data",
  "AppData\\Local\\Microsoft\\Edge\\User Data", "AppData\\Local\\BraveSoftware", "AppData\\Roaming\\Mozilla\\Firefox"] as const;

/**
 * Folders the owner's shell never writes, whatever its writable roots (the owner's decision of 2026-11-25, docs/plans/harness-1125.md
 * 「Skill 供应链」): the skill library, its quarantine and the repository's own `skills` folder. The worker names them once at start
 * (`protectSkillFolders`); every sandboxed thread denies them, so a worktree of the Crossline repository cannot rewrite a skill either.
 */
const protectedSkillFolders = new Set<string>();
export function protectSkillFolders(folders: string[]): void {
  for (const folder of folders) if (folder) protectedSkillFolders.add(folder);
}

/**
 * The thread config for the owner's shell under a Windows sandbox. The profile carries at least one `deny`: Codex re-runs a command
 * that failed in the sandbox without it once the command was approved (`tools/orchestrator.rs`), unless the profile denies a read
 * (`unsandboxed_execution_allowed`) — so the deny is what keeps every command inside. `features.network_proxy` starts Codex's managed
 * proxy, which takes the profile's domain list; MXC itself denies every direct connection off the computer.
 */
export function windowsShellConfig(sandbox: WindowsShellSandbox): Record<string, unknown> {
  const filesystem: Record<string, string> = { ":root": "read" };
  for (const path of sandbox.deny) filesystem[path] = "deny";
  for (const path of sandbox.writable) filesystem[path] = "write";
  // After the writable roots, so a skill folder inside one (or named as one) stays denied.
  for (const path of protectedSkillFolders) filesystem[path] = "deny";
  const network = sandbox.egress === "packages"
    ? { enabled: true, domains: Object.fromEntries(PACKAGE_DOMAINS.map((domain) => [domain, "allow"])) } : { enabled: false };
  return {
    default_permissions: WINDOWS_SHELL_PROFILE,
    permissions: { [WINDOWS_SHELL_PROFILE]: { description: "Crossline owner's shell", filesystem, network } },
    ...(sandbox.backend === "mxc" ? { "features.prefer_mxc": true } : {}),
    ...(sandbox.egress === "packages" ? { "features.network_proxy": true } : {}),
    ...(sandbox.env ? { shell_environment_policy: { set: sandbox.env } } : {})
  };
}

/**
 * The runtime's own word on its Windows sandbox: `windowsSandbox/readiness` (the effective local selection of the runtime as launched)
 * and the configured `windows.sandbox`. Undefined when it does not answer within `timeoutMs` (an older runtime, a runtime gone).
 */
export async function readWindowsSandbox(client: CodexRpcBoundary, timeoutMs = 5_000): Promise<{ readiness: string; configured?: string } | undefined> {
  const within = <T>(promise: Promise<T>) => Promise.race([promise, new Promise<undefined>((resolve) => { setTimeout(() => resolve(undefined), timeoutMs).unref?.(); })]);
  const field = (value: unknown, key: string) => typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
  try {
    const readiness = field(await within(client.request("windowsSandbox/readiness", {})), "status");
    if (typeof readiness !== "string") return undefined;
    const configured = field(field(field(await within(client.request("config/read", { includeLayers: false })), "config"), "windows"), "sandbox");
    return { readiness, ...(typeof configured === "string" ? { configured } : {}) };
  } catch {
    return undefined;
  }
}

type Handler = AgentMode["answer"];
const registries = new WeakMap<object, Map<string, Handler>>();

/**
 * Routes the runtime's requests to the run that owns the thread they are about. One client serves every run, and its single
 * request handler cannot know which run is asking, so each agent thread registers its own answerer here and the handler picks
 * by `threadId`. A request about a thread nobody registered is refused: nobody is there to judge it.
 */
export function registerAgentThread(client: CodexRpcBoundary, threadId: string, answer: Handler): () => void {
  let routes = registries.get(client);
  if (!routes) {
    const table = new Map<string, Handler>();
    routes = table;
    registries.set(client, table);
    client.onServerRequest?.((method, params) => {
      const record = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
      const handler = typeof record.threadId === "string" ? table.get(record.threadId) : undefined;
      if (!handler) throw new Error("no run is waiting on this thread");
      return handler(method, record);
    });
  }
  routes.set(threadId, answer);
  return () => { routes!.delete(threadId); };
}
