import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { loginMode, SESSION_COOKIES_FILE } from "./browser-launch";
import { holdProfile, profileHolder, releaseProfile } from "./profile-locks";
import {
  createRemoteBrowsers, parseRemoteInputs, remoteUrlAllowed, remoteViewport, REMOTE_ABANDON_MS, REMOTE_IDLE_MS, REMOTE_MAX_MS, toViewport,
  type OpenRemote, type RemoteBrowsersDeps, type RemotePage
} from "./remote-browser";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), "remote-browser-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("the popup is used where the worker has no screen of its own", () => {
  expect(loginMode({ CROSSLINE_PUBLIC_BETA: "1" }, "win32")).toBe("remote");
  expect(loginMode({}, "linux")).toBe("remote");
  expect(loginMode({ DISPLAY: ":0" }, "linux")).toBe("local");
  expect(loginMode({ WAYLAND_DISPLAY: "wayland-0" }, "linux")).toBe("local");
  expect(loginMode({}, "win32")).toBe("local");
  expect(loginMode({ CROSSLINE_LOGIN_MODE: "remote" }, "win32")).toBe("remote");
  expect(loginMode({ CROSSLINE_LOGIN_MODE: "local", CROSSLINE_PUBLIC_BETA: "1" }, "linux")).toBe("local");
});

test("a point of the frame lands on the browser's own pixels, inside the window", () => {
  expect(toViewport(0.5, 0.5, { width: 1280, height: 800 })).toEqual({ x: 640, y: 400 });
  expect(toViewport(0, 0, { width: 1280, height: 800 })).toEqual({ x: 0, y: 0 });
  expect(toViewport(1.4, -2, { width: 1280, height: 800 })).toEqual({ x: 1279, y: 0 });
  expect(remoteViewport(390, 700)).toEqual({ width: 390, height: 700 });
  expect(remoteViewport(5000, 10)).toEqual({ width: 1280, height: 560 });
  expect(remoteViewport(undefined, "x")).toEqual({ width: 1280, height: 800 });
});

test("inputs are checked before they reach the page", () => {
  expect(parseRemoteInputs([{ kind: "mouse", type: "click", x: 0.1, y: 0.2 }, { kind: "text", text: "密码 abc" }, { kind: "key", key: "Enter" },
    { kind: "wheel", x: 0.5, y: 0.5, dx: 0, dy: 99_999 }])).toEqual([{ kind: "mouse", type: "click", x: 0.1, y: 0.2 }, { kind: "text", text: "密码 abc" },
    { kind: "key", key: "Enter" }, { kind: "wheel", x: 0.5, y: 0.5, dx: 0, dy: 2000 }]);
  expect(parseRemoteInputs([{ kind: "key", key: "Control+a" }])).toEqual({ problem: expect.any(String) });
  expect(parseRemoteInputs([{ kind: "text", text: "a\nb" }])).toEqual({ problem: expect.any(String) });
  expect(parseRemoteInputs([{ kind: "text", text: "x".repeat(201) }])).toEqual({ problem: expect.any(String) });
  expect(parseRemoteInputs([{ kind: "mouse", type: "drag", x: 0, y: 0 }])).toEqual({ problem: expect.any(String) });
  expect(parseRemoteInputs([{ kind: "mouse", type: "click", x: Number.NaN, y: 0 }])).toEqual({ problem: expect.any(String) });
  expect(parseRemoteInputs([])).toEqual({ problem: expect.any(String) });
  expect(parseRemoteInputs(Array.from({ length: 61 }, () => ({ kind: "key", key: "Tab" })))).toEqual({ problem: expect.any(String) });
  // A refused text is never repeated back.
  expect(JSON.stringify(parseRemoteInputs([{ kind: "text", text: "hunter2\u0007" }]))).not.toContain("hunter2");
});

test("the login browser reaches only public https hosts", async () => {
  const looked: string[] = [];
  const allow = remoteUrlAllowed(async (host) => { looked.push(host); return host !== "inside.example.com"; });
  expect(await allow("https://login.wisc.edu/idp/profile/SAML2")).toBe(true);
  expect(await allow("https://api-1234.duosecurity.com/frame")).toBe(true);
  expect(await allow("wss://www.xiaohongshu.com/socket")).toBe(true);
  expect(await allow("http://www.xiaohongshu.com/")).toBe(false);
  expect(await allow("https://127.0.0.1/")).toBe(false);
  expect(await allow("https://[::1]/")).toBe(false);
  expect(await allow("https://localhost/")).toBe(false);
  expect(await allow("https://example.com:3211/v1/codex/status")).toBe(false);
  expect(await allow("https://inside.example.com/")).toBe(false);
  expect(await allow("file:///etc/passwd")).toBe(false);
  expect(await allow("https://login.wisc.edu/other")).toBe(true);
  expect(looked.filter((host) => host === "login.wisc.edu")).toHaveLength(1);
});

type Fake = { page: RemotePage; calls: string[]; frame: (data: string) => void; closed: () => boolean };
function fakeOpen(): { open: OpenRemote; pages: Fake[]; options: Array<Parameters<OpenRemote>[0]> } {
  const pages: Fake[] = [];
  const options: Array<Parameters<OpenRemote>[0]> = [];
  const open: OpenRemote = async (opened) => {
    options.push(opened);
    const calls: string[] = [];
    let url = "about:blank", closed = false;
    let push: ((frame: { data: string; width: number; height: number }) => void) | undefined;
    const page: RemotePage = {
      start: async (onFrame) => { push = onFrame; },
      goto: async (to) => { url = to; calls.push(`goto ${to}`); },
      mouse: async (type, x, y, button) => { calls.push(`${type} ${x},${y} ${button}`); },
      wheel: async (x, y, dx, dy) => { calls.push(`wheel ${x},${y} ${dx},${dy}`); },
      text: async () => { calls.push("text"); },
      key: async (key) => { calls.push(`key ${key}`); },
      back: async () => { calls.push("back"); }, reload: async () => { calls.push("reload"); },
      url: () => url, title: async () => "登录",
      sessionCookies: async () => [{ name: "sid", value: "v", domain: ".example.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }],
      close: async () => { closed = true; }
    };
    pages.push({ page, calls, frame: (data) => push?.({ data, width: 1280, height: 800 }), closed: () => closed });
    return page;
  };
  return { open, pages, options };
}

function setup(extra: Partial<RemoteBrowsersDeps> = {}) {
  let clock = 1_000_000;
  const logged: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  const fake = fakeOpen();
  const remote = createRemoteBrowsers({
    resolve: (workspaceId, workflowId, service) => service === "小红书" || service === "Canvas"
      ? { profileDir: path.join(dir, workspaceId, service === "小红书" ? "xiaohongshu.com" : "canvas.wisc.edu"), site: service === "小红书" ? "https://www.xiaohongshu.com/" : "https://canvas.wisc.edu/", label: service }
      : { code: "WORKFLOW_ACCESS_NOT_FOUND", message: "这个工作流不需要登录这个网站。" },
    onLoggedIn: (workspaceId, workflowId, service) => logged.push(`${workspaceId}/${workflowId}/${service}`),
    open: fake.open, memory: () => ({ used: 100, limit: 1000 }), highWater: 0.75, limit: 2, isPublicHost: async () => true,
    now: () => clock, log: (event) => events.push(event), ...extra
  });
  return { remote, fake, logged, events, advance: (ms: number) => { clock += ms; } };
}

test("a login opens the site, streams frames, and maps the person's input", async () => {
  const { remote, fake } = setup();
  const started = await remote.start("ws1", { workflowId: "flow-a", service: "小红书", width: 1000, height: 700 });
  expect(started).toMatchObject({ ok: true, session: { service: "小红书", url: "https://www.xiaohongshu.com/", viewport: { width: 1000, height: 700 } } });
  expect(fake.options[0]!.profileDir).toBe(path.join(dir, "ws1", "xiaohongshu.com"));
  expect(profileHolder(fake.options[0]!.profileDir)).toBe("login");
  expect(await remote.state("ws1", 0)).toMatchObject({ ok: true, open: true, seq: 0 });
  fake.pages[0]!.frame("AAAA");
  fake.pages[0]!.frame("BBBB");
  expect(await remote.state("ws1", 0)).toMatchObject({ seq: 2, frame: { data: "BBBB", seq: 2 } });
  // Nothing newer than what the dialog already has: no frame sent again.
  const same = await remote.state("ws1", 2) as Record<string, unknown>;
  expect(same.frame).toBeUndefined();
  expect(await remote.input("ws1", [{ kind: "mouse", type: "click", x: 0.5, y: 0.5 }, { kind: "text", text: "秘密" }, { kind: "key", key: "Enter" }, { kind: "wheel", x: 0, y: 1, dx: 0, dy: 300 }]))
    .toEqual({ ok: true });
  expect(fake.pages[0]!.calls).toEqual(["goto https://www.xiaohongshu.com/", "click 500,350 left", "text", "key Enter", "wheel 0,699 0,300"]);
  expect(await remote.input("ws1", [{ kind: "key", key: "F12" }])).toMatchObject({ ok: false, code: "REMOTE_INPUT_INVALID" });
  expect(await remote.nav("ws1", "back")).toEqual({ ok: true });
  expect(fake.pages[0]!.calls.at(-1)).toBe("back");
});

test("「登录完成」 closes the browser, keeps its session cookies and records the login", async () => {
  const { remote, fake, logged, events } = setup();
  await remote.start("ws1", { workflowId: "flow-a", service: "小红书" });
  const profile = fake.options[0]!.profileDir;
  expect(await remote.finish("ws1", "flow-a", "Canvas")).toMatchObject({ ok: false, code: "REMOTE_BROWSER_CLOSED" });
  expect(await remote.finish("ws1", "flow-a", "小红书")).toEqual({ ok: true });
  expect(logged).toEqual(["ws1/flow-a/小红书"]);
  expect(fake.pages[0]!.closed()).toBe(true);
  expect(profileHolder(profile)).toBeUndefined();
  expect(JSON.parse(readFileSync(path.join(profile, SESSION_COOKIES_FILE), "utf8"))).toEqual([expect.objectContaining({ name: "sid", expires: -1 })]);
  expect(remote.isOpen("ws1")).toBe(false);
  expect(await remote.state("ws1", 0)).toEqual({ ok: true, open: false });
  // Nothing typed is in what was logged.
  expect(JSON.stringify(events)).not.toContain("秘密");
});

test("「取消」 closes without recording a login", async () => {
  const { remote, fake, logged } = setup();
  await remote.start("ws1", { workflowId: "flow-a", service: "小红书" });
  expect(await remote.cancel("ws1")).toEqual({ ok: true });
  expect(fake.pages[0]!.closed()).toBe(true);
  expect(logged).toEqual([]);
});

test("one login browser per workspace, a few on the server, none above the memory mark", async () => {
  const { remote, fake } = setup();
  await remote.start("ws1", { workflowId: "flow-a", service: "小红书" });
  // Reopening the dialog shows the same browser.
  expect(await remote.start("ws1", { workflowId: "flow-a", service: "小红书" })).toMatchObject({ ok: true });
  expect(fake.pages).toHaveLength(1);
  expect(await remote.start("ws1", { workflowId: "flow-b", service: "Canvas" })).toMatchObject({ ok: false, code: "REMOTE_BROWSER_BUSY" });
  expect(await remote.start("ws2", { workflowId: "flow-c", service: "Canvas" })).toMatchObject({ ok: true });
  expect(await remote.start("ws3", { workflowId: "flow-d", service: "Canvas" })).toMatchObject({ ok: false, code: "REMOTE_BROWSER_LIMIT" });
  const tight = setup({ memory: () => ({ used: 800, limit: 1000 }) });
  expect(await tight.remote.start("ws9", { workflowId: "flow-a", service: "小红书" })).toMatchObject({ ok: false, code: "REMOTE_BROWSER_MEMORY" });
  expect(tight.fake.pages).toHaveLength(0);
  expect(await tight.remote.start("ws9", { workflowId: "flow-a", service: "微博" })).toMatchObject({ ok: false, code: "WORKFLOW_ACCESS_NOT_FOUND" });
});

test("a profile a reader or a collection holds is not opened for a login", async () => {
  const { remote, fake } = setup({ busy: (_ws, workflowId) => workflowId === "flow-busy" ? "正在读取收藏" : undefined });
  expect(await remote.start("ws1", { workflowId: "flow-busy", service: "小红书" })).toMatchObject({ ok: false, code: "WORKFLOW_BUSY" });
  const profile = path.join(dir, "ws1", "canvas.wisc.edu");
  expect(holdProfile(profile, "reader")).toBe(true);
  expect(await remote.start("ws1", { workflowId: "flow-a", service: "Canvas" })).toMatchObject({ ok: false, code: "PROFILE_IN_USE" });
  releaseProfile(profile, "reader");
  expect(fake.pages).toHaveLength(0);
  expect(await remote.start("ws1", { workflowId: "flow-a", service: "Canvas" })).toMatchObject({ ok: true });
  // And the other way round: a reader cannot take a profile a login holds.
  expect(holdProfile(profile, "reader")).toBe(false);
});

test("what the person leaves is closed: 10 minutes without input, 2 without the dialog, 30 in all", async () => {
  const idle = setup();
  await idle.remote.start("ws1", { workflowId: "flow-a", service: "小红书" });
  for (let minute = 0; minute < 9; minute += 1) { idle.advance(60_000); await idle.remote.state("ws1", 0); await idle.remote.sweep(); }
  expect(idle.remote.isOpen("ws1")).toBe(true);
  idle.advance(REMOTE_IDLE_MS - 9 * 60_000);
  await idle.remote.state("ws1", 0);
  await idle.remote.sweep();
  expect(idle.remote.isOpen("ws1")).toBe(false);
  expect(idle.events.at(-1)).toMatchObject({ type: "remote_browser.closed", reason: "idle" });
  expect(idle.logged).toEqual([]);

  const left = setup();
  await left.remote.start("ws1", { workflowId: "flow-a", service: "小红书" });
  left.advance(REMOTE_ABANDON_MS);
  await left.remote.sweep();
  expect(left.events.at(-1)).toMatchObject({ reason: "abandoned" });

  const long = setup();
  await long.remote.start("ws1", { workflowId: "flow-a", service: "小红书" });
  for (let minute = 0; minute < 30; minute += 1) {
    long.advance(60_000);
    if (minute < 29) { await long.remote.input("ws1", [{ kind: "mouse", type: "move", x: 0.1, y: 0.1 }]); await long.remote.sweep(); expect(long.remote.isOpen("ws1")).toBe(true); }
  }
  expect(30 * 60_000).toBe(REMOTE_MAX_MS);
  await long.remote.sweep();
  expect(long.events.at(-1)).toMatchObject({ reason: "expired" });
  // A closed profile can be opened again.
  expect(profileHolder(path.join(dir, "ws1", "xiaohongshu.com"))).toBeUndefined();
});

test("the browser failing to start leaves nothing held", async () => {
  const { remote } = setup({ open: async () => { throw new Error("no chromium"); } });
  expect(await remote.start("ws1", { workflowId: "flow-a", service: "小红书" })).toMatchObject({ ok: false, code: "REMOTE_BROWSER_FAILED" });
  expect(profileHolder(path.join(dir, "ws1", "xiaohongshu.com"))).toBeUndefined();
  expect(remote.isOpen("ws1")).toBe(false);
});

test("the supervisor service answers the dialog's routes", async () => {
  const { remote, fake } = setup();
  expect(await remote.handle("POST", "/v1/remote-browser/start", "ws1", { workflowId: "../x", service: "小红书" })).toMatchObject({ status: 400 });
  expect(await remote.handle("POST", "/v1/remote-browser/start", "ws1", { workflowId: "flow-a", service: "小红书", width: 390, height: 700 }))
    .toMatchObject({ status: 200, body: { ok: true, session: { viewport: { width: 390, height: 700 } } } });
  fake.pages[0]!.frame("CCCC");
  expect(await remote.handle("GET", "/v1/remote-browser/frame/0", "ws1", undefined)).toMatchObject({ status: 200, body: { frame: { data: "CCCC" } } });
  expect(await remote.handle("GET", "/v1/remote-browser/frame/abc", "ws1", undefined)).toBeUndefined();
  expect(await remote.handle("POST", "/v1/remote-browser/input", "ws1", { events: [{ kind: "key", key: "Tab" }] })).toMatchObject({ status: 200 });
  expect(await remote.handle("POST", "/v1/remote-browser/input", "ws2", { events: [{ kind: "key", key: "Tab" }] })).toMatchObject({ status: 200, body: { ok: false, code: "REMOTE_BROWSER_CLOSED" } });
  expect(await remote.handle("POST", "/v1/remote-browser/reload", "ws1", {})).toMatchObject({ status: 200 });
  expect(await remote.handle("POST", "/v1/remote-browser/finish", "ws1", {})).toMatchObject({ status: 200 });
  expect(existsSync(path.join(dir, "ws1", "xiaohongshu.com", SESSION_COOKIES_FILE))).toBe(true);
  expect(await remote.handle("DELETE", "/v1/remote-browser/finish", "ws1", {})).toBeUndefined();
});

test("a reader's own page is lent for the site's verification: shown as a verification, its browser never closed, its owner told how it ended", async () => {
  const { remote, fake, logged, advance } = setup();
  await fake.open({ profileDir: "x", viewport: { width: 1280, height: 800 }, allow: async () => true });
  const lent = fake.pages[0]!;
  const answers: boolean[] = [];
  expect(await remote.attach("ws1", { workflowId: "flow-a", service: "小红书", label: "小红书", page: lent.page, viewport: { width: 1280, height: 800 }, done: (ok) => answers.push(ok) })).toBe(true);
  // The person comes to it from a phone notification: not abandoned before the dialog first opens, within the wait.
  advance(5 * 60_000);
  await remote.sweep();
  expect(remote.isOpen("ws1", "flow-a")).toBe(true);
  // Reopening the dialog shows this page, said as a verification.
  expect(await remote.start("ws1", { workflowId: "flow-a", service: "小红书" })).toMatchObject({ ok: true, session: { purpose: "verify" } });
  expect(await remote.state("ws1", 0)).toMatchObject({ ok: true, open: true, session: { purpose: "verify" } });
  expect(await remote.finish("ws1", "flow-a", "小红书")).toEqual({ ok: true });
  expect(answers).toEqual([true]);
  expect(lent.closed()).toBe(false);
  expect(logged).toEqual([]);
  // One never opened is given up after the wait, and its owner told so.
  await remote.attach("ws1", { workflowId: "flow-a", service: "小红书", label: "小红书", page: lent.page, viewport: { width: 1280, height: 800 }, done: (ok) => answers.push(ok) });
  advance(16 * 60_000);
  await remote.sweep();
  expect(answers).toEqual([true, false]);
});
