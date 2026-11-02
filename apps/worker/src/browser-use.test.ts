import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BROWSER_USE_VERSION } from "@crossline/core";
import { browserUseDir, createBrowserUseTool, findPython } from "./browser-use";

/** The download path with a scripted shell: nothing is fetched, only the commands are checked. */
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const dataDir = () => { const dir = mkdtempSync(path.join(tmpdir(), "crossline-bu-test-")); dirs.push(dir); return dir; };
const venvPython = (dir: string) => process.platform === "win32" ? path.join(dir, "Scripts", "python.exe") : path.join(dir, "bin", "python");

function shell(versions: Record<string, string>, fail?: "venv" | "pip") {
  const calls: string[] = [];
  const run = async (command: string, args: string[]) => {
    calls.push([command, ...args].join(" "));
    if (args.includes("--version")) return versions[command] ? { code: 0, out: versions[command]! } : { code: 1, out: "" };
    if (args.includes("venv")) {
      if (fail === "venv") return { code: 1, out: "no venv module" };
      const dir = args.at(-1)!;
      mkdirSync(path.dirname(venvPython(dir)), { recursive: true });
      writeFileSync(venvPython(dir), "");
      return { code: 0, out: "" };
    }
    if (args.includes("pip")) return fail === "pip" ? { code: 1, out: "network down" } : { code: 0, out: "Successfully installed" };
    return { code: 1, out: "" };
  };
  return { calls, run };
}

describe("findPython", () => {
  it("skips a Python older than 3.11", async () => {
    const { run } = shell(process.platform === "win32" ? { py: "Python 3.10.4", python: "Python 3.12.1" } : { python3: "Python 3.10.4", python: "Python 3.12.1" });
    expect((await findPython(run))?.command).toBe("python");
  });
  it("finds nothing when no Python fits", async () => {
    expect(await findPython(shell({ python: "Python 2.7.18" }).run)).toBeUndefined();
  });
});

describe("createBrowserUseTool", () => {
  it("installs the pinned release into its own environment, only when asked", async () => {
    const data = dataDir();
    const { calls, run } = shell({ python: "Python 3.13.1", python3: "Python 3.13.1" });
    const tool = createBrowserUseTool({ dataDir: data, run });
    expect(tool.status().state).toBe("absent");
    expect(calls).toEqual([]);
    await tool.install();
    expect(tool.status()).toMatchObject({ state: "installed", version: BROWSER_USE_VERSION });
    expect(tool.python()).toBe(venvPython(browserUseDir(data)));
    expect(calls.some((call) => call.endsWith(`pip install --no-input browser-use==${BROWSER_USE_VERSION}`))).toBe(true);
  });

  it("says why a download failed and leaves nothing half installed", async () => {
    const data = dataDir();
    const tool = createBrowserUseTool({ dataDir: data, run: shell({ python: "Python 3.13.1", python3: "Python 3.13.1" }, "pip").run });
    await tool.install();
    expect(tool.status()).toMatchObject({ state: "failed" });
    expect(tool.status().error).toMatch(/^PIP_FAILED/);
    expect(tool.python()).toBeUndefined();
    expect(existsSync(browserUseDir(data))).toBe(false);
  });

  it("asks for Python when none fits", async () => {
    const tool = createBrowserUseTool({ dataDir: dataDir(), run: shell({}).run });
    await tool.install();
    expect(tool.status()).toMatchObject({ state: "failed", error: "PYTHON_MISSING" });
  });
});
