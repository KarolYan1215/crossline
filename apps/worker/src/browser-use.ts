import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BROWSER_USE_VERSION, pythonSupported, type BrowserUseProposal } from "@crossline/core";

/**
 * browser-use, the second fallback form engine (docs/opportunity-agent.md §10.7; MIT, checked on GitHub 2026-11-01). It is Python, so
 * it is not shipped: it is installed only when the person presses the download button on 设置 → 报名资料卡, which states the source
 * (PyPI), the size and the Python it needs, into a virtual environment of its own under the data directory (`tools/bu`, kept short:
 * pip fails on Windows under a long path). Nothing here runs without it, and a hosted worker has no screen, so it never installs there.
 */
export const browserUseDir = (dataDir: string) => path.join(dataDir, "tools", "bu");
const MARKER = "crossline.json";
const pythonIn = (dir: string) => process.platform === "win32" ? path.join(dir, "Scripts", "python.exe") : path.join(dir, "bin", "python");

export type BrowserUseStatus = { state: "absent" | "installing" | "installed" | "failed"; version: string; error?: string; python?: string };
type Command = { command: string; args: string[] };
type Run = (command: string, args: string[], timeoutMs: number) => Promise<{ code: number; out: string }>;

const runCommand: Run = (command, args, timeoutMs) => new Promise((resolve) => {
  execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PIP_NO_INPUT: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1" } },
    (error, stdout, stderr) => resolve({ code: error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0, out: `${stdout}${stderr}` }));
});

/** The first Python on this computer that browser-use runs on (3.11 or later). */
export async function findPython(run: Run = runCommand): Promise<(Command & { version: string }) | undefined> {
  const candidates: Command[] = process.platform === "win32"
    ? [{ command: "py", args: ["-3"] }, { command: "python", args: [] }, { command: "python3", args: [] }]
    : [{ command: "python3", args: [] }, { command: "python", args: [] }];
  for (const candidate of candidates) {
    const result = await run(candidate.command, [...candidate.args, "--version"], 15_000).catch(() => ({ code: 1, out: "" }));
    if (result.code === 0 && pythonSupported(result.out)) return { ...candidate, version: result.out.trim() };
  }
  return undefined;
}

export function createBrowserUseTool(options: { dataDir: string; run?: Run; log?: (event: Record<string, unknown>) => void }) {
  const dir = browserUseDir(options.dataDir);
  const run = options.run ?? runCommand;
  let installing = false;
  let failure: string | undefined;
  const installedVersion = () => {
    try { return (JSON.parse(readFileSync(path.join(dir, MARKER), "utf8")) as { version?: string }).version; } catch { return undefined; }
  };
  /** The environment's Python, only when this release finished installing there. */
  const python = () => installedVersion() === BROWSER_USE_VERSION && existsSync(pythonIn(dir)) ? pythonIn(dir) : undefined;
  const status = (): BrowserUseStatus => installing ? { state: "installing", version: BROWSER_USE_VERSION }
    : python() ? { state: "installed", version: BROWSER_USE_VERSION }
    : failure ? { state: "failed", version: BROWSER_USE_VERSION, error: failure } : { state: "absent", version: BROWSER_USE_VERSION };

  const install = async (): Promise<void> => {
    if (installing || python()) return;
    installing = true;
    failure = undefined;
    try {
      const found = await findPython(run);
      if (!found) { failure = "PYTHON_MISSING"; return; }
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(path.dirname(dir), { recursive: true });
      const venv = await run(found.command, [...found.args, "-m", "venv", dir], 5 * 60_000);
      if (venv.code !== 0) { failure = `VENV_FAILED: ${venv.out.slice(-300)}`; return; }
      const pip = await run(pythonIn(dir), ["-m", "pip", "install", "--no-input", `browser-use==${BROWSER_USE_VERSION}`], 40 * 60_000);
      if (pip.code !== 0) { failure = `PIP_FAILED: ${pip.out.slice(-300)}`; return; }
      writeFileSync(path.join(dir, MARKER), JSON.stringify({ version: BROWSER_USE_VERSION, python: found.version, at: new Date().toISOString() }));
      options.log?.({ event: "browser_use.installed", version: BROWSER_USE_VERSION, python: found.version });
    } finally {
      installing = false;
      if (failure) { rmSync(dir, { recursive: true, force: true }); options.log?.({ event: "browser_use.install_failed", error: failure.slice(0, 200) }); }
    }
  };
  return { status, install, python };
}

/**
 * The script browser-use runs from (written beside the throwaway browser for each run, run with `python -I`). Every action of
 * browser-use's own is taken away but `done`, `scroll`, `find_text` and `dropdown_options`; the one it gains, `propose_field`, only
 * records the element's accessibility role and name with the operation and value. Vision, the judge, highlights, downloads and the
 * captcha solver are off, and `allowed_domains` is the run's own hosts.
 */
const RUNNER = String.raw`import asyncio, json, os, sys
os.environ["ANONYMIZED_TELEMETRY"] = "false"
from typing import Literal
from pydantic import BaseModel
from browser_use import Agent, Tools, BrowserSession, BrowserProfile, ActionResult, ChatOpenAI

cfg = json.loads(sys.stdin.read())
proposals = []

class Propose(BaseModel):
    index: int
    op: Literal["fill", "select", "check"]
    value: str

keep = {"done", "scroll", "find_text", "dropdown_options"}
tools = Tools(exclude_actions=[name for name in Tools().registry.registry.actions if name not in keep])

@tools.registry.action("Propose one form field's value by its element index. It does not change the page; Crossline checks and fills it.", param_model=Propose)
async def propose_field(params: Propose, browser_session: BrowserSession):
    node = await browser_session.get_element_by_index(params.index)
    if node is None:
        return ActionResult(error="no element %d" % params.index)
    ax = node.ax_node
    if len(proposals) < 30:
        proposals.append({"role": (ax.role if ax else "") or "", "name": (ax.name if ax else "") or "", "op": params.op, "value": params.value[:300]})
    return ActionResult(extracted_content="noted %s for element %d" % (params.op, params.index))

async def main():
    session = BrowserSession(browser_profile=BrowserProfile(cdp_url=cfg["cdpUrl"], allowed_domains=cfg["allowedDomains"], keep_alive=True,
        highlight_elements=False, captcha_solver=False, accept_downloads=False))
    llm = ChatOpenAI(model="crossline-form-browser-agent", base_url=cfg["baseUrl"], api_key=cfg["apiKey"], max_retries=0)
    agent = Agent(task=cfg["task"], llm=llm, tools=tools, browser_session=session, use_vision=False, use_judge=False, use_thinking=False,
        max_failures=2, max_actions_per_step=10)
    try:
        await agent.run(max_steps=cfg["maxSteps"])
    finally:
        try:
            await session.stop()
        except Exception:
            pass
    print("@@" + json.dumps({"proposals": proposals}), flush=True)

asyncio.run(main())
`;

/** One browser-use run against the copy at `cdpUrl`, its model at `baseUrl`; the proposals it recorded, or undefined when it failed. */
export async function runBrowserUse(options: { python: string; scriptDir: string; cdpUrl: string; baseUrl: string; apiKey: string; task: string;
  allowedDomains: string[]; maxSteps: number; timeoutMs: number }): Promise<BrowserUseProposal[] | undefined> {
  const script = path.join(options.scriptDir, "crossline_browser_use.py");
  writeFileSync(script, RUNNER);
  const child = spawn(options.python, ["-I", script], { cwd: options.scriptDir, windowsHide: true,
    env: { ...process.env, ANONYMIZED_TELEMETRY: "false", BROWSER_USE_LOGGING_LEVEL: "warning", PYTHONIOENCODING: "utf-8" } });
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => { out = (out + chunk.toString("utf8")).slice(-200_000); });
  child.stderr.on("data", () => undefined);
  const timer = setTimeout(() => child.kill(), options.timeoutMs);
  child.stdin.end(JSON.stringify({ cdpUrl: options.cdpUrl, baseUrl: options.baseUrl, apiKey: options.apiKey, task: options.task,
    allowedDomains: options.allowedDomains, maxSteps: options.maxSteps }));
  await new Promise((resolve) => { child.on("exit", resolve); child.on("error", resolve); });
  clearTimeout(timer);
  const line = out.split(/\r?\n/).reverse().find((item) => item.startsWith("@@"));
  if (!line) return undefined;
  try { return ((JSON.parse(line.slice(2)) as { proposals?: BrowserUseProposal[] }).proposals ?? []).filter((item) => item && typeof item.name === "string"); }
  catch { return undefined; }
}
