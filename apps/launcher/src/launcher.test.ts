import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import { choosePorts, ensureSecrets, layoutFor, prepareConfig, PORT_RANGE, readRelease } from "./config";
import { childSpecs, noticeFrom, restartDelay, Supervisor, type ChildSpec, type SupervisorEvent } from "./supervise";

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "crossline-launcher-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("launcher config", () => {
  it("keeps a saved port while it is free and moves off one another program took", async () => {
    const taken = new Set([PORT_RANGE.first, 47250]);
    const free = async (port: number) => !taken.has(port);
    expect(await choosePorts({ webPort: 47240, supervisorPort: 47241 }, free)).toEqual({ webPort: 47240, supervisorPort: 47241 });
    expect(await choosePorts({ webPort: 47250, supervisorPort: 47241 }, free)).toEqual({ webPort: PORT_RANGE.first + 1, supervisorPort: 47241 });
  });

  it("asks the OS for a port when the whole range is held, never one a browser refuses, and never repeats one", async () => {
    const offered = [4190, 50123, 50123, 50124];
    const ports = await choosePorts({}, async () => false, async () => offered.shift()!);
    expect(ports).toEqual({ webPort: 50123, supervisorPort: 50124 });
    // A saved port a browser will not open is replaced, however free it is.
    expect((await choosePorts({ webPort: 4190 }, async () => true)).webPort).toBe(PORT_RANGE.first);
  });

  it("never gives the web and the supervisor the same port", async () => {
    const ports = await choosePorts({}, async () => true);
    expect(ports.webPort).not.toBe(ports.supervisorPort);
  });

  it("writes launcher.json on first run, keeps the install id after, and notices an upgrade", async () => {
    const root = temp();
    const layout = layoutFor(path.join(root, "app"), { CROSSLINE_LAUNCHER_ROOT: root });
    const first = await prepareConfig(layout, { version: "0.2.0" }, async () => true);
    expect(first.firstRun).toBe(true);
    const second = await prepareConfig(layout, { version: "0.3.0" }, async () => true);
    expect(second.firstRun).toBe(false);
    expect(second.config.installId).toBe(first.config.installId);
    expect(second.upgradedFrom).toBe("0.2.0");
    expect(JSON.parse(readFileSync(layout.config, "utf8")).version).toBe("0.3.0");
  });

  it("makes the secrets once and keeps them", () => {
    const file = path.join(temp(), "data", "launcher-secrets.json");
    const made = ensureSecrets(file);
    expect(made.betterAuthSecret.length).toBeGreaterThanOrEqual(40);
    expect(ensureSecrets(file)).toEqual(made);
  });

  it("reads the release a build baked in, and a development tree as 0.0.0-dev", () => {
    const app = temp();
    expect(readRelease(app).version).toBe("0.0.0-dev");
    writeFileSync(path.join(app, "release.json"), JSON.stringify({ version: "0.4.1", telemetryUrl: "https://example.test" }));
    expect(readRelease(app)).toEqual({ version: "0.4.1", telemetryUrl: "https://example.test" });
  });
});

describe("children", () => {
  const layout = layoutFor("C:\\Crossline\\app", { CROSSLINE_LAUNCHER_ROOT: "C:\\Crossline" });
  const config = { installId: "i", webPort: 47210, supervisorPort: 47211, version: "0.1.0" };
  const secrets = { betterAuthSecret: "a", capabilitySecret: "c", telemetrySalt: "s" };

  it("runs both on the bundled node and the bundled Codex, against the person's data folder", () => {
    const [web, worker] = childSpecs(layout, config, secrets, { version: "0.1.0" }, { PATH: "C:\\Windows" });
    expect(web!.command).toBe(path.join("C:\\Crossline\\app", "node.exe"));
    expect(worker!.command).toBe(web!.command);
    // The compiled worker, never TypeScript through tsx: no source ships.
    expect(worker!.args).toEqual([path.join("C:\\Crossline\\app", "apps", "worker", "dist", "index.mjs")]);
    expect(web!.args).toContain("47210");
    expect(web!.env.CROSSLINE_DATA_DIR).toBe(path.join("C:\\Crossline", "data"));
    expect(web!.env.CROSSLINE_CODEX_PATH).toBe(path.join("C:\\Crossline\\app", "codex", "codex.exe"));
    expect(worker!.env.CROSSLINE_CODEX_SUPERVISOR_PORT).toBe("47211");
    expect(web!.env.CROSSLINE_INSTALL_MODE).toBe("local");
  });

  it("drops every other way of signing in that the developer's shell might carry", () => {
    const [web] = childSpecs(layout, config, secrets, { version: "0.1.0" },
      { CROSSLINE_GOOGLE_CLIENT_ID: "g", CROSSLINE_SMTP_HOST: "smtp", CROSSLINE_CHATGPT_SIGNIN: "1", CROSSLINE_SEED_EXAMPLES: "1" });
    for (const key of ["CROSSLINE_GOOGLE_CLIENT_ID", "CROSSLINE_SMTP_HOST", "CROSSLINE_CHATGPT_SIGNIN", "CROSSLINE_SEED_EXAMPLES"]) expect(web!.env[key]).toBeUndefined();
  });

  it("trusts the Windows certificate store and keeps loopback off any proxy, whatever the tester's machine sets", () => {
    const [bare] = childSpecs(layout, config, secrets, { version: "0.1.0" }, {});
    expect(bare!.env.NODE_USE_SYSTEM_CA).toBe("1");
    expect(bare!.env.NO_PROXY).toBe("localhost,127.0.0.1,::1");
    const [proxied] = childSpecs(layout, config, secrets, { version: "0.1.0" }, { HTTPS_PROXY: "http://proxy:8080", NO_PROXY: "corp.example,localhost" });
    expect(proxied!.env.NO_PROXY).toBe("corp.example,localhost,127.0.0.1,::1");
  });

  it("backs off doubling up to a minute", () => {
    expect([1, 2, 3, 7, 20].map(restartDelay)).toEqual([1000, 2000, 4000, 60_000, 60_000]);
  });

  it("starts a child that exits again, and not after stop", async () => {
    const spawned: string[] = [];
    const children: Array<EventEmitter & { exitCode: number | null; signalCode: null; pid: number }> = [];
    const fake = (spec: ChildSpec) => {
      spawned.push(spec.name);
      const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null, pid: 1 });
      children.push(child);
      return child as unknown as ChildProcess;
    };
    const events: string[] = [];
    const supervisor = new Supervisor([{ name: "web", command: "x", args: [], cwd: ".", env: {} }], temp(), (event) => events.push(event.type), fake);
    supervisor.start();
    children[0]!.exitCode = 1;
    children[0]!.emit("exit", 1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(spawned).toEqual(["web", "web"]);
    children[1]!.exitCode = 0;
    await supervisor.stop(10);
    children[1]!.emit("exit", 0);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(spawned).toEqual(["web", "web"]);
    expect(events).toEqual(["child.started", "child.exited", "child.started"]);
  });
});

describe("notices from a child", () => {
  it("passes a checked notice line on to the tray, split across chunks, and ignores everything else a child prints", async () => {
    const events: SupervisorEvent[] = [];
    let child: (EventEmitter & { stdout: EventEmitter; pid: number; exitCode: number | null }) | undefined;
    const fake = () => { child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), pid: 1, exitCode: null, signalCode: null }); return child as unknown as ChildProcess; };
    const supervisor = new Supervisor([{ name: "web", command: "x", args: [], cwd: ".", env: {} }], temp(), (event) => events.push(event), fake);
    supervisor.start();
    const line = `@crossline:notify ${JSON.stringify({ title: "访谈下一轮已就绪", text: "点这里回到访谈。", path: "/onboarding" })}`;
    child!.stdout.emit("data", "▲ Next.js ready\n" + line.slice(0, 20));
    child!.stdout.emit("data", line.slice(20) + "\r\n");
    expect(events.filter((event) => event.type === "notify")).toEqual([{ type: "notify", title: "访谈下一轮已就绪", text: "点这里回到访谈。", path: "/onboarding" }]);
    // Let the child go (already exited, so nothing is killed), so its log files are closed before the folder is removed.
    child!.exitCode = 0;
    const stopped = supervisor.stop(10);
    child!.emit("exit", 0);
    await stopped;
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("refuses a notice that would open anything but one of the app's own pages", () => {
    const notice = (body: object) => noticeFrom(`@crossline:notify ${JSON.stringify(body)}`);
    expect(notice({ title: "t", text: "x", path: "https://evil.example" })).toBeUndefined();
    expect(notice({ title: "t", text: "x", path: "//evil.example" })).toBeUndefined();
    expect(notice({ title: "t", text: "x", path: "/a?b=1" })).toBeUndefined();
    expect(notice({ title: "", text: "x", path: "/" })).toBeUndefined();
    expect(noticeFrom("@crossline:notify {not json")).toBeUndefined();
    expect(noticeFrom("plain log line")).toBeUndefined();
  });
});

describe("workspace links", () => {
  it("links each workspace package under node_modules as a junction, and leaves a correct one alone", async () => {
    const { mkdirSync, realpathSync } = await import("node:fs");
    const { ensureWorkspaceLinks } = await import("./links");
    const app = temp();
    mkdirSync(path.join(app, "packages", "core"), { recursive: true });
    writeFileSync(path.join(app, "packages", "core", "package.json"), JSON.stringify({ name: "@crossline/core" }));
    writeFileSync(path.join(app, "packages", "core", "marker.txt"), "x");
    expect(ensureWorkspaceLinks(app)).toEqual(["@crossline/core"]);
    expect(readFileSync(path.join(app, "node_modules", "@crossline", "core", "marker.txt"), "utf8")).toBe("x");
    expect(realpathSync(path.join(app, "node_modules", "@crossline", "core")).toLowerCase()).toBe(realpathSync(path.join(app, "packages", "core")).toLowerCase());
    expect(ensureWorkspaceLinks(app)).toEqual([]);
  });
});
