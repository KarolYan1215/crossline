// i18n-exempt: page text matched on the site (「我」 is Xiaohongshu's own link), never shown
import { lookup } from "node:dns/promises";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

/** A target of the registration-form driver: the snapshot's ref first, role + name as the second way to find it (form-engine.ts). */
export type FormTarget = { ref?: string | undefined; role: string; name: string };
/** The form driver over one page, the same on the person's own worker and on a compute node (docs/opportunity-agent.md §10.1). */
export type FormPage = {
  open: (url: string) => Promise<void>;
  url: () => string;
  snapshot: () => Promise<string>;
  signals: () => Promise<{ passwordFields: number; frameUrls: string[]; required?: string[] }>;
  multiline: () => Promise<string[]>;
  inputValue: (target: FormTarget, attempt: number) => Promise<string | undefined>;
  fill: (target: FormTarget, value: string, attempt: number) => Promise<void>;
  select: (target: FormTarget, option: string, attempt: number) => Promise<void>;
  check: (target: FormTarget, on: boolean, attempt: number) => Promise<void>;
  upload: (target: FormTarget, file: string, attempt: number) => Promise<void>;
  click: (target: FormTarget) => Promise<void>;
  settle: () => Promise<void>;
  /** A full-page picture with the named fields masked. */
  picture: (mask: FormTarget[]) => Promise<Buffer>;
  front: () => Promise<void>;
  closed: () => boolean;
  close: () => Promise<void>;
  /**
   * The page's DOM as HTML, for the browser-use fallback's static copy (form-fallbacks.ts); read through Playwright, not a script in
   * the page. A node never sends it, so a node's form has no browser-use fallback.
   */
  html?: () => Promise<string>;
};

/** The name of the first node in an element's own accessibility snapshot (`- textbox "Name"`). */
const snapshotName = (yaml: string) => /^- [\w-]+ "((?:[^"\\]|\\.)*)"/m.exec(yaml)?.[1]?.replace(/\\(.)/g, "$1");
/** Luma moved from lu.ma to luma.com; an event link on one redirects to the other. */
const HOST_ALIASES: Record<string, string[]> = { "lu.ma": ["luma.com"], "luma.com": ["lu.ma"] };
/** The hosts one run may navigate to: the registration host and its known aliases, nothing else (§10.2). */
export const runHosts = (registrationHost: string): string[] => {
  const host = registrationHost.toLowerCase().replace(/^www\./, "");
  return host ? [host, ...(HOST_ALIASES[host] ?? [])] : [];
};
export const onHosts = (url: string, hosts: string[]) => {
  try { const host = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); return hosts.some((item) => host === item || host.endsWith(`.${item}`)); }
  catch { return false; }
};

/**
 * The registration-form driver over a context (docs/opportunity-agent.md §10.1–§10.2). Everything is read through the accessibility
 * snapshot and Playwright's locators, which run in Playwright's own isolated world: no script of ours runs in the page. A top-level
 * navigation may go only to `hosts`; requests `allow` refuses and popups are refused; each refusal goes to `onBlocked`.
 */
export async function driveFormContext(context: Context, options: { hosts: string[]; allow: (url: string) => Promise<boolean>; onBlocked: (url: string, why: string) => void }): Promise<FormPage> {
  type Page = import("playwright-core").Page;
  type Locator = import("playwright-core").Locator;
  const current: Page = context.pages()[0] ?? await context.newPage();
  // No second tab: a page that opens one gets it closed at once (§10.2: 不跨标签页).
  context.on("page", (page) => { if (page !== current) { options.onBlocked(page.url(), "popup"); void page.close().catch(() => undefined); } });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = request.url();
    const top = request.isNavigationRequest() && request.frame() === current.mainFrame();
    if (!(await options.allow(url))) { options.onBlocked(url, "address"); return route.abort("blockedbyclient"); }
    if (top && !onHosts(url, options.hosts)) { options.onBlocked(url, "host"); return route.abort("blockedbyclient"); }
    return route.continue();
  });
  // An element's own ariaSnapshot replaces the snapshot `aria-ref=` resolves against: after reading one, take the page's again, or a ref
  // from the engine's snapshot would find another element (a click meant for the dialog's button went nowhere).
  const keepRefs = async () => { await current.ariaSnapshot({ mode: "ai" }).catch(() => undefined); };
  const locate = (target: FormTarget, attempt: number): Locator => {
    if (attempt === 0 && target.ref) return current.locator(`aria-ref=${target.ref}`);
    if (attempt <= 1) return current.getByRole(target.role as Parameters<Page["getByRole"]>[0], { name: target.name, exact: true }).first();
    return current.getByLabel(target.name, { exact: true }).first();
  };
  return {
    open: async (url) => { await current.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }); },
    url: () => current.url(),
    snapshot: () => current.ariaSnapshot({ mode: "ai" }),
    signals: async () => {
      // Fields the page itself marks required, by their accessible names (read through locators, never a script in the page).
      const required: string[] = [];
      const marked = await current.locator("input:required:visible, textarea:required:visible, select:required:visible, [aria-required=true]:visible").all().catch(() => [] as Locator[]);
      for (const field of marked.slice(0, 40)) {
        const name = snapshotName(await field.ariaSnapshot().catch(() => ""));
        if (name) required.push(name);
      }
      if (marked.length) await keepRefs();
      return { passwordFields: await current.locator("input[type=password]:visible").count().catch(() => 0), frameUrls: current.frames().map((frame) => frame.url()), required };
    },
    multiline: async () => {
      const names: string[] = [];
      const areas = await current.locator("textarea").all().catch(() => [] as Locator[]);
      for (const area of areas) {
        const name = snapshotName(await area.ariaSnapshot().catch(() => ""));
        if (name) names.push(name);
      }
      if (areas.length) await keepRefs();
      return names;
    },
    inputValue: async (target, attempt) => locate(target, attempt).inputValue({ timeout: 3_000 }).catch(() => undefined),
    fill: async (target, value, attempt) => { await locate(target, attempt).fill(value, { timeout: 8_000 }); },
    select: async (target, option, attempt) => {
      const field = locate(target, attempt);
      try { await field.selectOption({ label: option }, { timeout: 4_000 }); }
      catch {
        // A combobox that is not a <select>: open it and pick the option by its name.
        await field.click({ timeout: 4_000 });
        await current.getByRole("option", { name: option, exact: true }).first().click({ timeout: 4_000 });
      }
    },
    check: async (target, on, attempt) => { await locate(target, attempt).setChecked(on, { timeout: 6_000 }); },
    upload: async (target, file, attempt) => {
      const field = locate(target, attempt);
      try { await field.setInputFiles(file, { timeout: 4_000 }); }
      catch {
        const chooser = current.waitForEvent("filechooser", { timeout: 6_000 });
        await field.click({ timeout: 4_000 });
        await (await chooser).setFiles(file);
      }
    },
    click: async (target) => { await locate(target, 0).click({ timeout: 8_000 }).catch(async () => locate(target, 1).click({ timeout: 8_000 })); },
    settle: async () => {
      await current.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => undefined);
      await current.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => undefined);
      await current.waitForTimeout(800);
    },
    picture: (mask) => current.screenshot({ fullPage: true, timeout: 15_000,
      mask: mask.map((target) => current.getByRole(target.role as Parameters<Page["getByRole"]>[0], { name: target.name, exact: true })) }),
    front: async () => { await current.bringToFront(); },
    closed: () => current.isClosed(),
    close: async () => { await context.close().catch(() => undefined); },
    html: () => current.content()
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
  | { op: "fetchMedia"; url: string; referer: string; maxBytes: number } | { op: "close" }
  // The registration-form driver (docs/opportunity-agent.md §10.1): a page of its own beside the reader's, answered with what it blocked.
  | { op: "formOpen"; host: string; hosts: string[] } | { op: "form"; method: FormMethod; args: unknown[] } | { op: "formPicture"; mask: FormTarget[] }
  | { op: "formClose" };
/** The form driver's methods a server may call on a node; `picture` and `close` go through their own ops; `html` does not go at all. */
export const FORM_METHODS = ["open", "snapshot", "signals", "multiline", "inputValue", "fill", "select", "check", "upload", "click", "settle", "front"] as const;
export type FormMethod = typeof FORM_METHODS[number];
/** What every form answer from a node carries besides the method's value: the page's address, whether it was closed, what was refused. */
export type FormAnswer = { value: unknown; url: string; closed: boolean; blocked: Array<{ url: string; why: string }>; error?: string };
const HOST_NAME = /^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/**
 * The computer's browsers, one per site (its own profile under `profilesDir`), driven by the server's operations. A site is opened in a
 * visible window of the person's own Chrome or Edge, as they logged in to it there; a second `open` of the same site reuses the window.
 */
export function createNodeBrowsers(options: { profilesDir: string; executable?: string; launch?: (profileDir: string, executable: string) => Promise<Context>;
  /** Where the browsers may go; a test serves its pages on loopback. */ allow?: (url: string) => Promise<boolean> }) {
  const executable = options.executable ?? findBrowser();
  const allow = options.allow ?? publicHttpsOnly();
  let current: { site: string; driver: ReaderDriver & { showMedia: (on: boolean) => void } } | undefined;
  let form: { page: FormPage; blocked: Array<{ url: string; why: string }>; uploads: string } | undefined;
  const launch = options.launch ?? (async (profileDir: string, exe: string) => {
    const { chromium } = await import("playwright-core");
    return chromium.launchPersistentContext(profileDir, { executablePath: exe, headless: false, viewport: null,
      args: ["--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-background-mode"] });
  });
  const closeForm = async () => { const closing = form; form = undefined; await closing?.page.close(); if (closing) rmSync(closing.uploads, { recursive: true, force: true }); };
  const formOp = async (request: Extract<BrowserOp, { op: "formOpen" | "form" | "formPicture" | "formClose" }>): Promise<unknown> => {
    if (request.op === "formOpen") {
      if (!executable) throw new Error("NODE_BROWSER_MISSING");
      const hosts = request.hosts.map((host) => String(host).toLowerCase()).filter((host) => HOST_NAME.test(host)).slice(0, 4);
      const host = String(request.host).toLowerCase();
      if (!HOST_NAME.test(host) || !hosts.includes(host)) throw new Error("NODE_FORM_HOST_INVALID");
      await closeForm();
      const profileDir = path.join(options.profilesDir, "forms", host);
      mkdirSync(profileDir, { recursive: true });
      const blocked: Array<{ url: string; why: string }> = [];
      const page = await driveFormContext(await launch(profileDir, executable), { hosts, allow, onBlocked: (url, why) => { if (blocked.length < 50) blocked.push({ url: url.slice(0, 300), why }); } });
      form = { page, blocked, uploads: path.join(options.profilesDir, "form-uploads", randomUUID()) };
      return { ok: true };
    }
    if (request.op === "formClose") { await closeForm(); return undefined; }
    const open = form;
    if (!open) throw new Error("NODE_FORM_NOT_OPEN");
    if (request.op === "formPicture") return { state: "ok", bytes: await open.page.picture(request.mask.slice(0, 40)), contentType: "image/png" };
    if (!(FORM_METHODS as readonly string[]).includes(request.method)) throw new Error("NODE_FORM_METHOD_REFUSED");
    const args = [...request.args];
    if (request.method === "upload") {
      // The file comes from the server as its bytes; it is kept in a folder of this run only, removed when the form closes.
      const file = args[1] as { name?: string; data?: string };
      const name = path.basename(String(file?.name ?? "upload")).replace(/[^\w.\- ]/g, "_").slice(0, 120) || "upload";
      mkdirSync(open.uploads, { recursive: true });
      const local = path.join(open.uploads, name);
      writeFileSync(local, Buffer.from(String(file?.data ?? ""), "base64"));
      args[1] = local;
    }
    const method = open.page[request.method] as (...values: unknown[]) => Promise<unknown>;
    // A failed method still answers with what was refused meanwhile: a navigation the guard aborted is why `open` failed.
    let value: unknown = null;
    let error: string | undefined;
    try { value = await method(...args); } catch (failure) { error = failure instanceof Error ? failure.message.slice(0, 300) : "NODE_FORM_FAILED"; }
    const answer: FormAnswer = { value: value ?? null, url: open.page.url(), closed: open.page.closed(), blocked: open.blocked.splice(0, open.blocked.length), ...(error ? { error } : {}) };
    return answer;
  };
  const handle = async (request: BrowserOp): Promise<unknown> => {
    if (request.op === "formOpen" || request.op === "form" || request.op === "formPicture" || request.op === "formClose") return formOp(request);
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
  return { available: Boolean(executable), handle, closeAll: async () => { await current?.driver.close(); current = undefined; await closeForm(); } };
}
export type NodeBrowsers = ReturnType<typeof createNodeBrowsers>;
