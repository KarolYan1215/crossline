import { mkdirSync } from "node:fs";
import { publicHttpsUrl } from "@crossline/core";
import { memoryHighWater, type MemoryReading } from "@crossline/codex";
import { REMOTE_VIEWPORT, saveSessionCookies } from "./browser-launch";
import { resolvesPublicly } from "./diligence";
import { containerMemory } from "./memory";
import { HOLDER_WORDS, holdProfile, profileHolder, releaseProfile } from "./profile-locks";
import { onServerScreen, serverDisplay } from "./server-display";

/**
 * Logging in to a site from the hosted beta, in a popup on the Crossline page (decided by the owner on 2026-10-22; docs/skills-library.md
 * 「托管版登录」). The server has no screen, so the login browser is a headless Chromium on the server, on the same profile folder the
 * readers use (`browserProfilesRoot/<site>`); its screen is streamed to the page (CDP `Page.startScreencast`, JPEG frames polled by the
 * dialog) and the person's clicks and typing are sent back as mouse and keyboard input. Whatever the site asks — a password, a code, a
 * Duo push, a captcha — the person does themselves in the dialog; nothing is typed, solved or stored for them. The login state stays in
 * that profile, and later reads run headless on it from the server, so the site sees the server's address (a Hong Kong data centre),
 * which the owner accepted.
 *
 * Limits held here, not in the dialog: one login browser per workspace and `CROSSLINE_REMOTE_BROWSERS` (1) on the server at once, none
 * above the worker's memory high-water mark; closed after 10 minutes without input, 2 minutes without the dialog asking for a frame, or
 * 30 minutes in all; only public https pages on the default port, every request checked (a page cannot make the server's browser call
 * an address on the server's own network, which would otherwise reach the worker's own supervisor); no downloads, no service workers.
 * Typed text passes straight to the page: it is never logged, kept or echoed.
 */
export const REMOTE_IDLE_MS = 10 * 60_000;
export const REMOTE_ABANDON_MS = 2 * 60_000;
export const REMOTE_MAX_MS = 30 * 60_000;
export const REMOTE_TEXT_MAX = 200;
export const REMOTE_EVENTS_MAX = 60;
/** How long a reader waits for the person to open a verification it lent them before it stops as it would have. */
export const VERIFY_WAIT_MS = 15 * 60_000;
// One by default: a Chromium page holds ~150–250 MB inside the worker's ceiling, which has no room set aside for it (deploy/server/run.sh),
// and logging in is rare; a second person waits a few minutes rather than the worker's runtimes being killed for memory.
const remoteLimit = (env: NodeJS.ProcessEnv = process.env) => Math.max(1, Math.floor(Number(env.CROSSLINE_REMOTE_BROWSERS) || 1));

/** Keys sent as keys, not text: what a login form needs. Anything typed is text (`insertText`), so an input method works too. */
export const REMOTE_KEYS = ["Enter", "Backspace", "Tab", "Escape", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Shift+Tab"] as const;
export type RemoteKey = typeof REMOTE_KEYS[number];
export type Viewport = { width: number; height: number };

/** One input from the dialog. Positions are fractions of the frame (0–1), so the dialog may draw it at any size. */
export type RemoteInput =
  | { kind: "mouse"; type: "move" | "down" | "up" | "click"; x: number; y: number; button?: "left" | "right" | "middle" }
  | { kind: "wheel"; x: number; y: number; dx: number; dy: number }
  | { kind: "text"; text: string }
  | { kind: "key"; key: RemoteKey };

/** A point of the frame in the browser's own pixels, kept inside the window. */
export function toViewport(x: number, y: number, viewport: Viewport): { x: number; y: number } {
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return { x: Math.round(clamp(x) * (viewport.width - 1)), y: Math.round(clamp(y) * (viewport.height - 1)) };
}

/** The window asked for, kept to what a phone or a laptop shows: 360–1280 wide, 560–900 tall. */
export function remoteViewport(width: unknown, height: unknown): Viewport {
  const pick = (value: unknown, min: number, max: number, fallback: number) => {
    const number = Math.round(Number(value));
    return Number.isFinite(number) && number > 0 ? Math.min(max, Math.max(min, number)) : fallback;
  };
  return { width: pick(width, 360, 1280, REMOTE_VIEWPORT.width), height: pick(height, 560, 900, REMOTE_VIEWPORT.height) };
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
// Control characters other than none at all: a key is sent as a key, never as a character in text.
const CONTROL = /[\u0000-\u001f\u007f]/;
/** The dialog's inputs as the browser may receive them, or why not; nothing of a refused text is repeated back. */
export function parseRemoteInputs(value: unknown): RemoteInput[] | { problem: string } {
  if (!Array.isArray(value) || !value.length) return { problem: "没有输入" };
  if (value.length > REMOTE_EVENTS_MAX) return { problem: "一次的输入太多" };
  const out: RemoteInput[] = [];
  for (const raw of value as Array<Record<string, unknown>>) {
    if (!raw || typeof raw !== "object") return { problem: "输入格式不对" };
    if (raw.kind === "mouse") {
      if (!["move", "down", "up", "click"].includes(String(raw.type)) || !finite(raw.x) || !finite(raw.y)) return { problem: "鼠标输入格式不对" };
      const button = raw.button === undefined ? undefined : String(raw.button);
      if (button !== undefined && !["left", "right", "middle"].includes(button)) return { problem: "鼠标按键不对" };
      out.push({ kind: "mouse", type: raw.type as "move", x: raw.x, y: raw.y, ...(button ? { button: button as "left" } : {}) });
    } else if (raw.kind === "wheel") {
      if (!finite(raw.x) || !finite(raw.y) || !finite(raw.dx) || !finite(raw.dy)) return { problem: "滚动输入格式不对" };
      const clampDelta = (delta: number) => Math.max(-2000, Math.min(2000, delta));
      out.push({ kind: "wheel", x: raw.x, y: raw.y, dx: clampDelta(raw.dx), dy: clampDelta(raw.dy) });
    } else if (raw.kind === "text") {
      if (typeof raw.text !== "string" || !raw.text || raw.text.length > REMOTE_TEXT_MAX || CONTROL.test(raw.text)) return { problem: "文字输入格式不对" };
      out.push({ kind: "text", text: raw.text });
    } else if (raw.kind === "key") {
      if (!(REMOTE_KEYS as readonly string[]).includes(String(raw.key))) return { problem: "不支持这个按键" };
      out.push({ kind: "key", key: raw.key as RemoteKey });
    } else return { problem: "输入格式不对" };
  }
  return out;
}

/**
 * Whether the login browser may request an address: public https on the default port, a real host name that resolves only to public
 * addresses (cached per host for the session). Pages, frames, scripts and sockets alike.
 */
export function remoteUrlAllowed(isPublicHost: (host: string) => Promise<boolean>): (url: string) => Promise<boolean> {
  const hosts = new Map<string, Promise<boolean>>();
  return async (url) => {
    const parsed = publicHttpsUrl(url.replace(/^wss:/i, "https:"));
    if (!parsed) return false;
    const host = parsed.hostname.toLowerCase();
    if (!hosts.has(host)) hosts.set(host, isPublicHost(host).catch(() => false));
    return hosts.get(host)!;
  };
}

/** What the session manager needs from a browser. The real one is Playwright (`openRemotePage`); tests give their own. */
export type RemotePage = {
  /** Starts streaming; every new frame (base64 JPEG) goes to `onFrame`, already acknowledged. */
  start: (onFrame: (frame: { data: string; width: number; height: number }) => void) => Promise<void>;
  goto: (url: string) => Promise<void>;
  mouse: (type: "move" | "down" | "up" | "click", x: number, y: number, button: "left" | "right" | "middle") => Promise<void>;
  wheel: (x: number, y: number, dx: number, dy: number) => Promise<void>;
  text: (text: string) => Promise<void>;
  key: (key: RemoteKey) => Promise<void>;
  back: () => Promise<void>;
  reload: () => Promise<void>;
  url: () => string;
  title: () => Promise<string>;
  /** Cookies that end with the browser (see `saveSessionCookies`). */
  sessionCookies: () => Promise<Parameters<typeof saveSessionCookies>[1]>;
  close: () => Promise<void>;
  /** Stops streaming and leaves the browser to its owner: a page lent for a verification (`attach`) is never closed here. */
  detach?: () => Promise<void>;
};
export type OpenRemote = (options: { profileDir: string; executablePath?: string; viewport: Viewport; allow: (url: string) => Promise<boolean> }) => Promise<RemotePage>;

/** Where a workflow's login lives and what to open first, or why this login cannot be opened. */
export type RemoteTarget = { profileDir: string; site: string; label: string };
export type RemoteResult = { ok: true; [key: string]: unknown } | { ok: false; code: string; message: string };

type Session = {
  workspaceId: string; workflowId: string; service: string; label: string; profileDir: string; viewport: Viewport;
  page: RemotePage; startedAt: number; lastInput: number; lastPoll: number;
  frame?: { data: string; width: number; height: number; seq: number }; seq: number; queue: Promise<void>;
  /** A page a reader lent for the site's verification (`attach`): its owner is told how it ended, and its browser is not closed here. */
  lent?: { done: (verified: boolean) => void; polled: boolean };
};
/** `verify`: the dialog shows a reader's own page for the person to pass the site's check, then 「验证完成」. */
export type RemoteView = { workflowId: string; service: string; label: string; url: string; title: string; viewport: Viewport; startedAt: string; endsAt: string; purpose: "login" | "verify" };

export type RemoteBrowsersDeps = {
  resolve: (workspaceId: string, workflowId: string, service: string) => RemoteTarget | { code: string; message: string };
  /** The person pressed 「登录完成」: the login is recorded the way the window path records it (`skill.grown.logged_in`). */
  onLoggedIn: (workspaceId: string, workflowId: string, service: string) => void;
  /** Something else of this workflow is under way that the login would clash with (a collection), or undefined. */
  busy?: (workspaceId: string, workflowId: string) => string | undefined;
  open?: OpenRemote;
  executablePath?: () => string | undefined;
  memory?: () => MemoryReading | undefined;
  highWater?: number;
  limit?: number;
  isPublicHost?: (host: string) => Promise<boolean>;
  now?: () => number;
  log?: (event: Record<string, unknown>) => void;
};

/** The login browsers of this worker, one per workspace, and the `/v1/remote-browser` service the web's popup talks to. */
export function createRemoteBrowsers(deps: RemoteBrowsersDeps) {
  const sessions = new Map<string, Session>();
  const starting = new Set<string>();
  const now = () => deps.now?.() ?? Date.now();
  const log = deps.log ?? (() => {});
  const view = async (session: Session): Promise<RemoteView> => ({ workflowId: session.workflowId, service: session.service, label: session.label,
    url: session.page.url(), title: (await session.page.title().catch(() => "")).slice(0, 200), viewport: session.viewport,
    startedAt: new Date(session.startedAt).toISOString(), endsAt: new Date(session.startedAt + REMOTE_MAX_MS).toISOString(), purpose: session.lent ? "verify" : "login" });

  /** Closes a session: its session cookies are kept beside the profile, the profile is let go. Never throws. */
  const close = async (session: Session, reason: string): Promise<void> => {
    if (sessions.get(session.workspaceId) !== session) return;
    sessions.delete(session.workspaceId);
    if (session.lent) {
      await session.page.detach?.().catch(() => undefined);
      log({ type: "remote_browser.verify_ended", workspaceId: session.workspaceId, workflowId: session.workflowId, reason });
      session.lent.done(reason === "finished");
      return;
    }
    try { saveSessionCookies(session.profileDir, await session.page.sessionCookies()); } catch { /* the persistent cookies are in the profile anyway */ }
    await session.page.close().catch(() => undefined);
    releaseProfile(session.profileDir, "login");
    log({ type: "remote_browser.closed", workspaceId: session.workspaceId, workflowId: session.workflowId, reason, minutes: Math.round((now() - session.startedAt) / 60_000) });
  };

  const start = async (workspaceId: string, input: { workflowId: string; service: string; width?: unknown; height?: unknown }): Promise<RemoteResult> => {
    const existing = sessions.get(workspaceId);
    if (existing) {
      // Reopening the dialog (a reload, another tab) shows the same browser; another site waits for this one.
      if (existing.workflowId === input.workflowId && existing.service === input.service) { existing.lastPoll = now(); return { ok: true, session: await view(existing) }; }
      return { ok: false, code: "REMOTE_BROWSER_BUSY", message: `${existing.label}的登录窗口还开着；先在那里点「登录完成」或「取消」。` };
    }
    if (starting.has(workspaceId)) return { ok: false, code: "REMOTE_BROWSER_STARTING", message: "登录窗口正在打开。" };
    const target = deps.resolve(workspaceId, input.workflowId, input.service);
    if ("code" in target) return { ok: false, code: target.code, message: target.message };
    const busy = deps.busy?.(workspaceId, input.workflowId);
    if (busy) return { ok: false, code: "WORKFLOW_BUSY", message: `${busy}，结束后再登录。` };
    const holder = profileHolder(target.profileDir);
    if (holder && holder !== "login") return { ok: false, code: "PROFILE_IN_USE", message: `${HOLDER_WORDS[holder]}，结束后再登录。` };
    if (sessions.size + starting.size >= (deps.limit ?? remoteLimit())) return { ok: false, code: "REMOTE_BROWSER_LIMIT", message: "服务器上同时打开的登录窗口已满，过几分钟再试。" };
    const memory = (deps.memory ?? containerMemory)();
    if (memory && memory.limit > 0 && memory.used / memory.limit >= (deps.highWater ?? memoryHighWater()))
      return { ok: false, code: "REMOTE_BROWSER_MEMORY", message: "服务器内存紧张，登录窗口暂时打不开，过几分钟再试。" };
    if (!holdProfile(target.profileDir, "login")) return { ok: false, code: "PROFILE_IN_USE", message: "这个网站的浏览器正被占用，稍后再登录。" };
    starting.add(workspaceId);
    const viewport = remoteViewport(input.width, input.height);
    let page: RemotePage | undefined;
    try {
      mkdirSync(target.profileDir, { recursive: true });
      const executablePath = deps.executablePath?.();
      page = await (deps.open ?? openRemotePage)({ profileDir: target.profileDir, ...(executablePath ? { executablePath } : {}), viewport,
        allow: remoteUrlAllowed(deps.isPublicHost ?? resolvesPublicly) });
      const at = now();
      const session: Session = { workspaceId, workflowId: input.workflowId, service: input.service, label: target.label, profileDir: target.profileDir, viewport,
        page, startedAt: at, lastInput: at, lastPoll: at, seq: 0, queue: Promise.resolve() };
      await page.start((frame) => { session.seq += 1; session.frame = { ...frame, seq: session.seq }; });
      sessions.set(workspaceId, session);
      await page.goto(target.site).catch(() => undefined);
      log({ type: "remote_browser.opened", workspaceId, workflowId: input.workflowId, service: input.service });
      return { ok: true, session: await view(session) };
    } catch (error) {
      sessions.delete(workspaceId);
      await page?.close().catch(() => undefined);
      releaseProfile(target.profileDir, "login");
      log({ type: "remote_browser.failed", workspaceId, workflowId: input.workflowId, message: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
      return { ok: false, code: "REMOTE_BROWSER_FAILED", message: "服务器上的浏览器没有打开，稍后再试。" };
    } finally { starting.delete(workspaceId); }
  };

  /**
   * A reader's own page shown in the dialog for the site's verification (the person passes it; nothing is solved for them): no browser
   * is opened, the reader keeps its page and is told by `done` whether the person pressed 「验证完成」. False when a dialog is already open.
   */
  const attach = async (workspaceId: string, input: { workflowId: string; service: string; label: string; page: RemotePage; viewport: Viewport; done: (verified: boolean) => void }): Promise<boolean> => {
    if (sessions.has(workspaceId) || starting.has(workspaceId)) return false;
    const at = now();
    const session: Session = { workspaceId, workflowId: input.workflowId, service: input.service, label: input.label, profileDir: "", viewport: input.viewport,
      page: input.page, startedAt: at, lastInput: at, lastPoll: at, seq: 0, queue: Promise.resolve(), lent: { done: input.done, polled: false } };
    try { await input.page.start((frame) => { session.seq += 1; session.frame = { ...frame, seq: session.seq }; }); }
    catch { return false; }
    sessions.set(workspaceId, session);
    log({ type: "remote_browser.verify_opened", workspaceId, workflowId: input.workflowId });
    return true;
  };

  /** The latest frame when it is newer than `after`, with where the browser is; asking counts as the dialog still being open. */
  const state = async (workspaceId: string, after: number): Promise<RemoteResult> => {
    const session = sessions.get(workspaceId);
    if (!session) return { ok: true, open: false };
    session.lastPoll = now();
    if (session.lent) session.lent.polled = true;
    const frame = session.frame && session.frame.seq > after ? session.frame : undefined;
    return { ok: true, open: true, session: await view(session), seq: session.frame?.seq ?? 0, ...(frame ? { frame } : {}) };
  };

  /** Inputs in order: one session's are queued behind each other, so a click lands before the text typed after it. */
  const input = async (workspaceId: string, raw: unknown): Promise<RemoteResult> => {
    const session = sessions.get(workspaceId);
    if (!session) return { ok: false, code: "REMOTE_BROWSER_CLOSED", message: "登录窗口已经关闭。" };
    const events = parseRemoteInputs(raw);
    if (!Array.isArray(events)) return { ok: false, code: "REMOTE_INPUT_INVALID", message: events.problem };
    session.lastInput = now();
    session.lastPoll = session.lastInput;
    const run = session.queue.then(async () => {
      for (const event of events) {
        if (event.kind === "mouse") { const point = toViewport(event.x, event.y, session.viewport); await session.page.mouse(event.type, point.x, point.y, event.button ?? "left"); }
        else if (event.kind === "wheel") { const point = toViewport(event.x, event.y, session.viewport); await session.page.wheel(point.x, point.y, event.dx, event.dy); }
        else if (event.kind === "text") await session.page.text(event.text);
        else await session.page.key(event.key);
      }
    });
    session.queue = run.catch(() => undefined);
    try { await run; return { ok: true }; }
    catch { return { ok: false, code: "REMOTE_INPUT_FAILED", message: "页面没有接收这次操作。" }; }
  };

  const nav = async (workspaceId: string, action: "back" | "reload"): Promise<RemoteResult> => {
    const session = sessions.get(workspaceId);
    if (!session) return { ok: false, code: "REMOTE_BROWSER_CLOSED", message: "登录窗口已经关闭。" };
    session.lastInput = now();
    await (action === "back" ? session.page.back() : session.page.reload()).catch(() => undefined);
    return { ok: true };
  };

  /** 「登录完成」: the browser closes (its cookies are in the profile) and the login is recorded. */
  const finish = async (workspaceId: string, workflowId?: string, service?: string): Promise<RemoteResult> => {
    const session = sessions.get(workspaceId);
    if (!session || (workflowId && session.workflowId !== workflowId) || (service && session.service !== service))
      return { ok: false, code: "REMOTE_BROWSER_CLOSED", message: "登录窗口已经关闭；需要的话重新登录。" };
    await close(session, "finished");
    if (!session.lent) deps.onLoggedIn(workspaceId, session.workflowId, session.service);
    return { ok: true };
  };

  const cancel = async (workspaceId: string): Promise<RemoteResult> => {
    const session = sessions.get(workspaceId);
    if (session) await close(session, "cancelled");
    return { ok: true };
  };

  /** Closes what the person left: no input for 10 minutes, no dialog asking for 2, or 30 minutes in all. Not a login; nothing recorded. */
  const sweep = async (): Promise<void> => {
    const at = now();
    for (const session of [...sessions.values()]) {
      // A lent page waits for the person to come to it (a phone notification): it is not abandoned before its dialog was first opened.
      const abandoned = at - session.lastPoll >= REMOTE_ABANDON_MS && (!session.lent || session.lent.polled);
      const reason = at - session.startedAt >= REMOTE_MAX_MS ? "expired" : at - session.lastInput >= (session.lent && !session.lent.polled ? VERIFY_WAIT_MS : REMOTE_IDLE_MS) ? "idle"
        : abandoned ? "abandoned" : undefined;
      if (reason) await close(session, reason);
    }
  };

  const isOpen = (workspaceId: string, workflowId?: string) => {
    const session = sessions.get(workspaceId);
    return Boolean(session && (!workflowId || session.workflowId === workflowId));
  };

  /** `/v1/remote-browser`: `GET /frame/<after>`, `POST /start`, `/input`, `/back`, `/reload`, `/finish`, `/cancel`. */
  const handle = async (method: string, pathname: string, workspaceId: string, body: Record<string, unknown> | undefined): Promise<{ status: number; body: unknown } | undefined> => {
    const rest = pathname.slice("/v1/remote-browser".length);
    // Refusals are answers ({ok:false, code, message}), so the dialog can say why; a status other than 200 would lose them on the way.
    const answer = (result: RemoteResult) => ({ status: 200, body: result });
    if (method === "GET") {
      const match = /^\/frame\/(\d{1,9})$/.exec(rest);
      return match ? answer(await state(workspaceId, Number(match[1]))) : undefined;
    }
    if (method !== "POST") return undefined;
    if (rest === "/start") {
      const workflowId = String(body?.workflowId ?? ""), service = String(body?.service ?? "");
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(workflowId) || !service.trim() || service.length > 40) return { status: 400, body: { ok: false, code: "INVALID_REQUEST", message: "请求格式不对" } };
      return answer(await start(workspaceId, { workflowId, service, width: body?.width, height: body?.height }));
    }
    if (rest === "/input") return answer(await input(workspaceId, body?.events));
    if (rest === "/back" || rest === "/reload") return answer(await nav(workspaceId, rest.slice(1) as "back"));
    if (rest === "/finish") return answer(await finish(workspaceId));
    if (rest === "/cancel") return answer(await cancel(workspaceId));
    return undefined;
  };

  const closeAll = async () => { for (const session of [...sessions.values()]) await close(session, "shutdown"); };
  return { start, attach, state, input, nav, finish, cancel, sweep, isOpen, handle, closeAll };
}
export type RemoteBrowsers = ReturnType<typeof createRemoteBrowsers>;

/**
 * The real login browser: Playwright's Chromium on the site's profile, in a window on the server's virtual screen. Every request (pages, frames, scripts, sockets) is
 * checked by `allow`; service workers are blocked so none escapes that check; downloads are refused. A page the site opens (a sign-in
 * popup) is streamed while it is open and the stream goes back to the page under it when it closes. No stealth, no user agent of our
 * own: the browser says what it is.
 */
export const openRemotePage: OpenRemote = async ({ profileDir, executablePath, viewport, allow }) => {
  const { chromium } = await import("playwright-core");
  // A window on the server's virtual screen (server-display.ts): an ordinary Chromium, not HeadlessChrome; headless only without Xvfb.
  const screen = onServerScreen(await serverDisplay(), viewport);
  const context = await chromium.launchPersistentContext(profileDir, { ...(executablePath ? { executablePath } : {}), headless: screen.headless,
    ...(screen.env ? { env: screen.env } : {}), viewport, acceptDownloads: false, serviceWorkers: "block",
    args: ["--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-background-mode", ...screen.extraArgs] });
  await context.route("**/*", async (route) => { if (await allow(route.request().url())) await route.continue(); else await route.abort("blockedbyclient"); });
  await context.routeWebSocket(/.*/, async (socket) => { if (await allow(socket.url())) socket.connectToServer(); else await socket.close(); });
  return castContext(context, viewport);
};

/** Where every page of the server's browsers may go: public https hosts only (the same check the login browser has). */
export const publicUrlAllowed = remoteUrlAllowed(resolvesPublicly);

/**
 * A browser context streamed to the dialog: its top page's frames, and the person's input to it. `lent`: the context belongs to a reader
 * (the favourites job lends its own page for a verification), so `detach` only stops the stream and `close` leaves the browser open.
 */
export async function castContext(context: import("playwright-core").BrowserContext, viewport: Viewport, lent = false): Promise<RemotePage> {
  type Page = import("playwright-core").Page;
  type Cdp = import("playwright-core").CDPSession;
  const stack: Page[] = [context.pages()[0] ?? await context.newPage()];
  const top = () => stack[stack.length - 1]!;
  let cdp: Cdp | undefined;
  let onFrame: ((frame: { data: string; width: number; height: number }) => void) | undefined;
  const cast = async (page: Page) => {
    const before = cdp;
    cdp = undefined;
    await before?.send("Page.stopScreencast").catch(() => undefined);
    await before?.detach().catch(() => undefined);
    const session = await context.newCDPSession(page);
    session.on("Page.screencastFrame", (frame) => {
      onFrame?.({ data: frame.data, width: frame.metadata.deviceWidth ?? viewport.width, height: frame.metadata.deviceHeight ?? viewport.height });
      void session.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => undefined);
    });
    await session.send("Page.enable").catch(() => undefined);
    await session.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: viewport.width, maxHeight: viewport.height, everyNthFrame: 1 });
    cdp = session;
  };
  const follow = (page: Page) => {
    page.on("close", () => {
      const at = stack.indexOf(page);
      if (at >= 0) stack.splice(at, 1);
      if (!stack.length) { void context.newPage().then((fresh) => { stack.push(fresh); follow(fresh); return onFrame ? cast(fresh) : undefined; }).catch(() => undefined); return; }
      if (onFrame && at === stack.length) void cast(top()).catch(() => undefined);
    });
  };
  follow(stack[0]!);
  context.on("page", (page) => { stack.push(page); follow(page); if (onFrame) void cast(page).catch(() => undefined); });
  const button = (name: "left" | "right" | "middle") => ({ button: name });
  const stop = async () => {
    onFrame = undefined;
    const before = cdp;
    cdp = undefined;
    await before?.send("Page.stopScreencast").catch(() => undefined);
    await before?.detach().catch(() => undefined);
  };
  return {
    start: async (handler) => { onFrame = handler; await cast(top()); },
    goto: async (url) => { await top().goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }); },
    mouse: async (type, x, y, name) => {
      const mouse = top().mouse;
      if (type === "click") await mouse.click(x, y, button(name));
      else { await mouse.move(x, y); if (type === "down") await mouse.down(button(name)); else if (type === "up") await mouse.up(button(name)); }
    },
    wheel: async (x, y, dx, dy) => { await top().mouse.move(x, y); await top().mouse.wheel(dx, dy); },
    text: (text) => top().keyboard.insertText(text),
    key: (key) => top().keyboard.press(key),
    back: async () => { await top().goBack({ timeout: 15_000 }); },
    reload: async () => { await top().reload({ timeout: 30_000 }); },
    url: () => top().url(),
    title: () => top().title(),
    sessionCookies: async () => (await context.cookies()).filter((cookie) => cookie.expires === -1),
    close: async () => { if (lent) await stop(); else await context.close(); },
    detach: stop
  };
}
