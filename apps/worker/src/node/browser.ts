import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";

/**
 * A reader's browser, the same on the hosted server and on the person's own computer (docs/compute-node.md 「浏览器读取放到节点」, the
 * owner's request of 2026-10-24: the favourites read on the server filled its memory at ~1360 notes, while the person's computer sat
 * idle). Nothing of Crossline's other logic is here, so the standalone node bundles it (scripts/package-node.ts).
 *
 * `driveContext` turns a Playwright context into the driver the favourites job uses: the page's own answers to the URLs `capture` names
 * are kept as JSON (nothing is ever requested from a site's API by this code), the page's text and links on demand, pictures and videos
 * through the context's own requests. Every request is held to `allow`. No disguise of any kind: no user agent, no stealth, no proxy.
 *
 * `createNodeBrowsers` is the computer's end: the server sends the driver's operations over the node's connection and gets the answers
 * back; the window is the person's own, visible on their screen, so a site's verification or login is done there by them.
 */
export type ReaderResponse = { url: string; status: number; json: unknown };
export type ReaderMedia = { state: "ok"; bytes: Buffer; contentType: string } | { state: "too_large"; bytes: number } | { state: "failed"; status: number; message?: string };
export type ReaderDriver = {
  goto: (url: string) => Promise<number>;
  pause: (ms: number) => Promise<void>;
  wheel: () => Promise<void>;
  snapshot: () => Promise<{ url: string; title: string; text: string; links: Array<{ text: string; href: string }> }>;
  responses: () => Promise<ReaderResponse[]>;
  noteState: () => Promise<unknown>;
  selfProfile: () => Promise<{ userId?: string; href?: string }>;
  fetchMedia: (url: string, referer: string, maxBytes: number) => Promise<ReaderMedia>;
  metrics?: () => Promise<{ heapMb: number; nodes: number }>;
  /** The window brought to the front of the person's screen (a verification or login waits there). */
  front?: () => Promise<void>;
  close: () => Promise<void>;
};

type Context = import("playwright-core").BrowserContext;

/**
 * The driver over a context. `listOnly`: pictures, videos and fonts are not loaded (only titles are wanted) unless `showMedia()` says a
 * person needs to see the page (a verification is made of pictures).
 */
export async function driveContext(context: Context, options: { capture: (url: string) => boolean; allow: (url: string) => Promise<boolean>; listOnly?: boolean }):
  Promise<ReaderDriver & { showMedia: (on: boolean) => void }> {
  let showing = false;
  await context.route("**/*", async (route) => {
    const request = route.request();
    if (!(await options.allow(request.url()))) return route.abort("blockedbyclient");
    return options.listOnly && !showing && ["image", "media", "font"].includes(request.resourceType()) ? route.abort() : route.continue();
  });
  // Functions handed to the page name nothing (tsx's `__name` wrapper would throw there).
  await context.addInitScript({ content: "globalThis.__name = globalThis.__name || ((target) => target);" });
  const page = context.pages()[0] ?? await context.newPage();
  const queue: ReaderResponse[] = [];
  const pending = new Set<Promise<void>>();
  page.on("response", (response) => {
    const url = response.url();
    if (!options.capture(url)) return;
    const done = response.json().then((json: unknown) => { queue.push({ url, status: response.status(), json }); },
      () => { queue.push({ url, status: response.status(), json: null }); }).finally(() => pending.delete(done));
    pending.add(done);
  });
  return {
    showMedia: (on) => { showing = on; },
    goto: async (url) => (await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }))?.status() ?? 0,
    pause: (ms) => page.waitForTimeout(ms),
    wheel: () => page.mouse.wheel(0, 900),
    snapshot: async () => ({ url: page.url(), ...(await page.evaluate(() => ({ title: document.title, text: (document.body?.innerText ?? "").slice(0, 60_000),
      links: [...document.querySelectorAll("a[href]")].slice(0, 3_000).map((anchor) => ({ text: (anchor.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
        href: (anchor as HTMLAnchorElement).href })) }))) }),
    responses: async () => { await Promise.allSettled([...pending]); return queue.splice(0, queue.length); },
    metrics: () => page.evaluate(() => ({ heapMb: Math.round(((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1_048_576),
      nodes: document.getElementsByTagName("*").length })),
    noteState: () => page.evaluate(() => {
      const plain = (value: unknown) => { try { return JSON.parse(JSON.stringify(value ?? null)) as unknown; } catch { return null; } };
      const state = (globalThis as unknown as { __INITIAL_STATE__?: { note?: { noteDetailMap?: unknown } } }).__INITIAL_STATE__;
      return plain(state?.note?.noteDetailMap ?? null);
    }),
    selfProfile: () => page.evaluate(() => {
      const state = (globalThis as unknown as { __INITIAL_STATE__?: { user?: { userInfo?: Record<string, unknown> } } }).__INITIAL_STATE__;
      const info = state?.user?.userInfo as Record<string, unknown> | undefined;
      const inner = (info && typeof info === "object" && "_value" in info ? info._value : info?.value ?? info) as Record<string, unknown> | undefined;
      const userId = typeof inner?.userId === "string" ? inner.userId : typeof inner?.user_id === "string" ? inner.user_id : undefined;
      const me = [...document.querySelectorAll("a[href*='/user/profile/']")].find((anchor) => (anchor.textContent ?? "").trim() === "我") as HTMLAnchorElement | undefined;
      return { ...(userId ? { userId } : {}), ...(me ? { href: me.href } : {}) };
    }),
    fetchMedia: async (url, referer, maxBytes) => {
      if (!(await options.allow(url))) return { state: "failed", status: 0, message: "NOT_ALLOWED" };
      const headers = { referer };
      const head = await page.request.head(url, { headers, timeout: 60_000 }).catch(() => undefined);
      const declared = Number(head?.headers()["content-length"] ?? 0);
      if (declared > maxBytes) return { state: "too_large", bytes: declared };
      const response = await page.request.get(url, { headers, timeout: 15 * 60_000 });
      if (!response.ok()) return { state: "failed", status: response.status() };
      const bytes = await response.body();
      if (bytes.length > maxBytes) return { state: "too_large", bytes: bytes.length };
      return { state: "ok", bytes, contentType: response.headers()["content-type"] ?? "" };
    },
    front: () => page.bringToFront(),
    close: () => context.close().catch(() => undefined)
  };
}

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
const privateAddress = (address: string) => isIP(address) === 6 ? /^(::1|fc|fd|fe80)/i.test(address) : PRIVATE_V4.some((pattern) => pattern.test(address));
/**
 * Where a browser on the person's computer may go: https on the usual port to a name (never an address) that resolves only to public
 * addresses, so a page from the server cannot reach the person's own network or the computer itself.
 */
export function publicHttpsOnly(resolve: (host: string) => Promise<string[]> = async (host) => (await lookup(host, { all: true })).map((item) => item.address)) {
  const hosts = new Map<string, Promise<boolean>>();
  return async (url: string): Promise<boolean> => {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return false; }
    if (parsed.protocol === "data:" || parsed.protocol === "blob:" || parsed.protocol === "about:") return true;
    if (parsed.protocol !== "https:" || (parsed.port && parsed.port !== "443")) return false;
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (isIP(host) || host === "localhost" || host.endsWith(".local") || host.endsWith(".localhost") || !host.includes(".")) return false;
    if (!hosts.has(host)) hosts.set(host, resolve(host).then((addresses) => addresses.length > 0 && !addresses.some(privateAddress)).catch(() => false));
    return hosts.get(host)!;
  };
}

/** Chrome or Edge on this computer (`CROSSLINE_NODE_BROWSER` names another), or undefined. */
export function findBrowser(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const named = env.CROSSLINE_NODE_BROWSER?.trim();
  if (named) return existsSync(named) ? named : undefined;
  const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean) as string[];
  const candidates = roots.flatMap((root) => [path.join(root, "Google", "Chrome", "Application", "chrome.exe"), path.join(root, "Microsoft", "Edge", "Application", "msedge.exe")]);
  return candidates.find((file) => existsSync(file));
}

/** One operation of the driver, sent by the server; `capture` is the URL patterns whose answers are kept (regular expression sources). */
export type BrowserOp =
  | { op: "open"; site: string; capture: string[]; listOnly?: boolean }
  | { op: "goto"; url: string } | { op: "pause"; ms: number } | { op: "wheel" } | { op: "snapshot" } | { op: "responses" }
  | { op: "noteState" } | { op: "selfProfile" } | { op: "metrics" } | { op: "front" } | { op: "showMedia"; on: boolean }
  | { op: "fetchMedia"; url: string; referer: string; maxBytes: number } | { op: "close" };

/**
 * The computer's browsers, one per site (its own profile under `profilesDir`), driven by the server's operations. A site is opened in a
 * visible window of the person's own Chrome or Edge, as they logged in to it there; a second `open` of the same site reuses the window.
 */
export function createNodeBrowsers(options: { profilesDir: string; executable?: string; launch?: (profileDir: string, executable: string) => Promise<Context> }) {
  const executable = options.executable ?? findBrowser();
  const allow = publicHttpsOnly();
  let current: { site: string; driver: ReaderDriver & { showMedia: (on: boolean) => void } } | undefined;
  const launch = options.launch ?? (async (profileDir: string, exe: string) => {
    const { chromium } = await import("playwright-core");
    return chromium.launchPersistentContext(profileDir, { executablePath: exe, headless: false, viewport: null,
      args: ["--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-background-mode"] });
  });
  const handle = async (request: BrowserOp): Promise<unknown> => {
    if (request.op === "open") {
      if (!executable) throw new Error("NODE_BROWSER_MISSING");
      const site = new URL(request.site);
      if (site.protocol !== "https:") throw new Error("NODE_SITE_NOT_HTTPS");
      if (current) { await current.driver.close(); current = undefined; }
      const host = site.hostname.toLowerCase().replace(/^www\./, "").replace(/[^a-z0-9.-]/g, "");
      const profileDir = path.join(options.profilesDir, host);
      mkdirSync(profileDir, { recursive: true });
      const patterns = request.capture.slice(0, 10).map((source) => new RegExp(source));
      const context = await launch(profileDir, executable);
      current = { site: host, driver: await driveContext(context, { capture: (url) => patterns.some((pattern) => pattern.test(url)), allow, listOnly: Boolean(request.listOnly) }) };
      return { ok: true };
    }
    const driver = current?.driver;
    if (!driver) throw new Error("NODE_BROWSER_NOT_OPEN");
    switch (request.op) {
      case "goto": return driver.goto(request.url);
      case "pause": return driver.pause(Math.min(request.ms, 300_000));
      case "wheel": return driver.wheel();
      case "snapshot": return driver.snapshot();
      case "responses": return driver.responses();
      case "noteState": return driver.noteState();
      case "selfProfile": return driver.selfProfile();
      case "metrics": return driver.metrics?.();
      case "front": return driver.front?.();
      case "showMedia": driver.showMedia(request.on); return undefined;
      case "fetchMedia": return driver.fetchMedia(request.url, request.referer, request.maxBytes);
      case "close": { const closing = current; current = undefined; await closing?.driver.close(); return undefined; }
    }
    return undefined;
  };
  return { available: Boolean(executable), handle, closeAll: async () => { await current?.driver.close(); current = undefined; } };
}
export type NodeBrowsers = ReturnType<typeof createNodeBrowsers>;
