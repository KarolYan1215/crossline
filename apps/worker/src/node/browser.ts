// i18n-exempt: page text matched on the site (「我」 is Xiaohongshu's own link), never shown
import { lookup } from "node:dns/promises";
import { createHash, randomUUID } from "node:crypto";
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
  /** A full-page picture with the named fields, and every password box, masked. */
  picture: (mask: FormTarget[]) => Promise<Buffer>;
  /**
   * The engine's egress guard (docs/plans/harness-1125.md §3): while on, any request but GET/HEAD to a host off the run's hosts is
   * aborted (a third-party tracker cannot carry off what was just typed), each host reported once as `egress`. On from the window's
   * opening; the engine lifts it when the window is the person's (a stop, a form waiting for their submission) and sets it again on 继续.
   */
  egress: (on: boolean) => Promise<void>;
  /**
   * A saved login typed by the driver itself into the top-level page's login form, then that form's button pressed (§5). Only on this
   * computer's own worker: it is not one of the node's methods, so a login never travels over a node's connection. Refused unless the
   * form holds nothing but the username and password boxes (a sign-up form is not a login) and its button reads as signing in.
   */
  login?: (secret: { username: string; password: string }) => Promise<{ ok: true; filled: Array<"username" | "password">; mask: FormTarget[] } | { ok: false; why: string }>;
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
/** A login form's username box, on the top-level page. */
const LOGIN_USER = ["autocomplete=username", "type=email", "name*=user i", "name*=email i", "name*=login i", "id*=user i", "id*=email i", "id*=login i"]
  .map((attr) => `input[${attr}]:visible`).join(", ");
/** A box a person types into or picks in; a login form has only its username and password among them. */
const TYPED_BOX = "input:visible:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=image]):not([type=reset]), textarea:visible, select:visible";
/** A login form's own button: signing in or going on to the password step, never signing up. */
// i18n-ignore: matched against what a site shows
const LOGIN_BUTTON = /^(log ?in|sign ?in|continue|next|submit|go|登录|登入|继续|下一步|确定|提交)(\b|$)/i;
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
  let egress = true;
  const egressSeen = new Set<string>();
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = request.url();
    const top = request.isNavigationRequest() && request.frame() === current.mainFrame();
    if (!(await options.allow(url))) { options.onBlocked(url, "address"); return route.abort("blockedbyclient"); }
    if (top && !onHosts(url, options.hosts)) { options.onBlocked(url, "host"); return route.abort("blockedbyclient"); }
    if (egress && !/^(GET|HEAD)$/i.test(request.method()) && !onHosts(url, options.hosts)) {
      let host = "";
      try { host = new URL(url).hostname; } catch { /* not a URL */ }
      if (!egressSeen.has(host)) { egressSeen.add(host); options.onBlocked(url, "egress"); }
      return route.abort("blockedbyclient");
    }
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
      mask: [...mask.map((target) => current.getByRole(target.role as Parameters<Page["getByRole"]>[0], { name: target.name, exact: true })), current.locator("input[type=password]")] }),
    egress: async (on) => { egress = on; },
    login: async (secret) => {
      // The top-level page only: `current.locator` never looks into a frame, so a login box another origin's frame shows is never filled.
      const passwords = await current.locator("input[type=password]:visible").all();
      if (passwords.length > 1) return { ok: false, why: "several password boxes" }; // i18n-ignore: a code kept on the run
      const password = passwords[0];
      // The username box of the password's own form when there is one; a page's other e-mail box (a newsletter) is not it.
      const passwordForm = password?.locator("xpath=ancestor::form[1]");
      const scope = passwordForm && await passwordForm.count() ? passwordForm : current.locator(":root");
      const user = (await scope.locator(LOGIN_USER).all())[0];
      const last = password ?? user;
      if (!last) return { ok: false, why: "no login box" }; // i18n-ignore: a code kept on the run
      const form = last.locator("xpath=ancestor::form[1]");
      const inForm = (await form.count()) ? form : undefined;
      // Every box a person would type into, in the login's form: more than the username and password means it is not a login.
      const boxes = inForm ? await inForm.locator(TYPED_BOX).count() : (user ? 1 : 0) + (password ? 1 : 0);
      if (boxes > (user ? 1 : 0) + (password ? 1 : 0)) return { ok: false, why: "not only a login form" }; // i18n-ignore: a code kept on the run
      const button = inForm?.locator("button[type=submit]:visible, input[type=submit]:visible, button:not([type]):visible").first();
      const buttonName = button && await button.count() ? snapshotName(await button.ariaSnapshot().catch(() => "")) ?? "" : undefined;
      if (buttonName !== undefined && !LOGIN_BUTTON.test(buttonName.trim())) return { ok: false, why: "button is not a sign-in" }; // i18n-ignore: a code kept on the run
      const filled: Array<"username" | "password"> = [];
      const mask: FormTarget[] = [];
      for (const [box, value, kind] of [[user, secret.username, "username"], [password, secret.password, "password"]] as const) {
        if (!box) continue;
        await box.fill(value, { timeout: 8_000 });
        if ((await box.inputValue({ timeout: 3_000 })) !== value) return { ok: false, why: `${kind} not read back` }; // i18n-ignore: a code kept on the run
        const name = snapshotName(await box.ariaSnapshot().catch(() => ""));
        if (name) mask.push({ role: "textbox", name });
        filled.push(kind);
      }
      if (button && buttonName !== undefined) await button.click({ timeout: 8_000 }); else await last.press("Enter", { timeout: 8_000 });
      await keepRefs();
      return { ok: true, filled, mask };
    },
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

/**
 * The sensitive profile items of an account whose forms open on this computer (docs/plans/harness-1125.md §9.3, the owner's decision of
 * 2026-11-25): phone, birth date, student id, address, id and passport numbers live only in this computer's secret store (`apply-<slot>`);
 * the hosted server keeps only that one is held. The device worker gives its DPAPI store, the standalone node its own DPAPI files.
 */
export type NodeVault = {
  read: (name: string) => Promise<string | undefined>;
  write: (name: string, value: string) => Promise<void>;
  remove: (name: string) => Promise<void> | void;
};
/** A slot name as the server names it (`phone`, `id_number`); nothing else becomes a file name here. */
const VAULT_SLOT = /^[a-z][a-z_]{1,39}$/;
/** The server's placeholder for a sensitive slot (core's `profilePlaceholder`): typed here as the held value, never as itself. */
const PLACEHOLDER = /^\{\{profile\.([a-z][a-z_]{1,39})\}\}$/;
export const vaultName = (slot: string) => `apply-${slot}`;
export const vaultHash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
/**
 * Every held value (and its digits-only form, for a phone the page reformats) replaced by its placeholder, in everything a form answer
 * carries back to the server — the same rule as core's `redactSensitive`, which this bundle cannot import. Values under four characters
 * are left: they would blank ordinary words.
 */
export function redactHeld<T>(value: T, held: ReadonlyMap<string, string>): T {
  if (!held.size) return value;
  const text = (input: string) => {
    let out = input;
    for (const [slot, secret] of held) {
      const plain = secret.trim();
      if (plain.length < 4) continue;
      out = out.split(plain).join(`{{profile.${slot}}}`);
      const digits = plain.replace(/\D/g, "");
      if (digits.length >= 6) out = out.replace(new RegExp(digits.split("").join("[\\s().+-]*"), "g"), `{{profile.${slot}}}`);
    }
    return out;
  };
  const walk = (item: unknown): unknown => typeof item === "string" ? text(item) : Array.isArray(item) ? item.map(walk)
    : item && typeof item === "object" && !Buffer.isBuffer(item) ? Object.fromEntries(Object.entries(item).map(([key, inner]) => [key, walk(inner)])) : item;
  return walk(value) as T;
}

/** One operation of the driver, sent by the server; `capture` is the URL patterns whose answers are kept (regular expression sources). */
export type BrowserOp =
  | { op: "open"; site: string; capture: string[]; listOnly?: boolean }
  | { op: "goto"; url: string } | { op: "pause"; ms: number } | { op: "wheel" } | { op: "snapshot" } | { op: "responses" }
  | { op: "noteState" } | { op: "selfProfile" } | { op: "metrics" } | { op: "front" } | { op: "showMedia"; on: boolean }
  | { op: "fetchMedia"; url: string; referer: string; maxBytes: number } | { op: "close" }
  // The registration-form driver (docs/opportunity-agent.md §10.1): a page of its own beside the reader's, answered with what it blocked.
  // `vault` names the sensitive slots the ledger says are held: read here once for the open form, to type and to redact.
  | { op: "formOpen"; host: string; hosts: string[]; vault?: string[] } | { op: "form"; method: FormMethod; args: unknown[] } | { op: "formPicture"; mask: FormTarget[] }
  | { op: "formClose" }
  // The vault (`NodeVault`): a value saved here, answered with the sha256 of what reads back (never the value); a value removed.
  | { op: "vaultPut"; slot: string; value: string } | { op: "vaultRemove"; slot: string };
/** The form driver's methods a server may call on a node; `picture` and `close` go through their own ops; `html` and `login` do not go at all. */
export const FORM_METHODS = ["open", "snapshot", "signals", "multiline", "inputValue", "fill", "select", "check", "upload", "click", "settle", "front", "egress"] as const;
export type FormMethod = typeof FORM_METHODS[number];
/** What every form answer from a node carries besides the method's value: the page's address, whether it was closed, what was refused. */
export type FormAnswer = { value: unknown; url: string; closed: boolean; blocked: Array<{ url: string; why: string }>; error?: string };
const HOST_NAME = /^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/**
 * The computer's browsers, one per site (its own profile under `profilesDir`), driven by the server's operations. A site is opened in a
 * visible window of the person's own Chrome or Edge, as they logged in to it there; a second `open` of the same site reuses the window.
 */
export function createNodeBrowsers(options: { profilesDir: string; executable?: string; launch?: (profileDir: string, executable: string) => Promise<Context>;
  /** Where the browsers may go; a test serves its pages on loopback. */ allow?: (url: string) => Promise<boolean>;
  /** This computer's secret store for the sensitive profile items; without one the node says no `vault` and the server never asks. */
  vault?: NodeVault }) {
  const executable = options.executable ?? findBrowser();
  const allow = options.allow ?? publicHttpsOnly();
  let current: { site: string; driver: ReaderDriver & { showMedia: (on: boolean) => void } } | undefined;
  let form: { page: FormPage; blocked: Array<{ url: string; why: string }>; uploads: string; held: Map<string, string> } | undefined;
  const launch = options.launch ?? (async (profileDir: string, exe: string) => {
    const { chromium } = await import("playwright-core");
    return chromium.launchPersistentContext(profileDir, { executablePath: exe, headless: false, viewport: null,
      args: ["--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-background-mode"] });
  });
  let lastShot: { sha: string; at: number; page: string } | undefined;
  /**
   * The phone's signed 「提交」 (docs/plans/remote-control-1122.md §6.5): only on the screenshot the person saw (two minutes at most, the
   * page unchanged since), never on a page asking for a password or a payment, and only a button that reads as a submit.
   */
  const formSubmitFromPhone = async (input: { shot: string; button: { role: string; name: string } }): Promise<{ ok: true; picture?: Buffer } | { ok: false; why: string }> => {
    const open = form;
    if (!open || open.page.closed()) return { ok: false, why: "表单窗口已关闭" };
    if (!lastShot || lastShot.sha !== input.shot || Date.now() - lastShot.at > 2 * 60_000) return { ok: false, why: "截图已过期，请重新截图" };
    const snapshot = await open.page.snapshot();
    if (createHash("sha256").update(snapshot).digest("hex") !== lastShot.page) return { ok: false, why: "截图之后页面变了" };
    if ((await open.page.signals()).passwordFields > 0) return { ok: false, why: "页面要求密码" };
    if (/card number|cvc|cvv|expiry|payment|checkout|pay now|信用卡|付款|支付/i.test(snapshot)) return { ok: false, why: "页面涉及付款" };
    if (input.button.role !== "button" || !/submit|register|apply|sign up|rsvp|join|confirm|提交|报名|申请|注册|确认/i.test(input.button.name)) return { ok: false, why: "不是提交按钮" };
    await open.page.click({ role: "button", name: input.button.name });
    await open.page.settle().catch(() => undefined);
    lastShot = undefined;
    return { ok: true, picture: await open.page.picture([]).catch(() => Buffer.alloc(0)) };
  };
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
      // The held values, in memory for this form only (gone at `formClose`); a slot the store does not have is simply not typed.
      const held = new Map<string, string>();
      for (const slot of (Array.isArray(request.vault) ? request.vault : []).map(String).filter((item) => VAULT_SLOT.test(item)).slice(0, 12)) {
        const value = await options.vault?.read(vaultName(slot)).catch(() => undefined);
        if (value) held.set(slot, value);
      }
      const page = await driveFormContext(await launch(profileDir, executable), { hosts, allow, onBlocked: (url, why) => { if (blocked.length < 50) blocked.push({ url: url.slice(0, 300), why }); } });
      form = { page, blocked, uploads: path.join(options.profilesDir, "form-uploads", randomUUID()), held };
      return { ok: true };
    }
    if (request.op === "formClose") { await closeForm(); return undefined; }
    const open = form;
    if (!open) throw new Error("NODE_FORM_NOT_OPEN");
    if (request.op === "formPicture") {
      const bytes = await open.page.picture(request.mask.slice(0, 40));
      // Kept for a submit from the phone (remote.ts): what the person saw, when, and what the page held then.
      lastShot = { sha: createHash("sha256").update(bytes).digest("hex"), at: Date.now(), page: createHash("sha256").update(await open.page.snapshot()).digest("hex") };
      return { state: "ok", bytes, contentType: "image/png" };
    }
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
    if (request.method === "fill" || request.method === "select") {
      // A sensitive slot comes as its placeholder and is typed as the value held here; a placeholder is never typed as itself.
      const given = String(args[1] ?? "");
      const slot = PLACEHOLDER.exec(given)?.[1];
      if (slot) {
        const held = open.held.get(slot);
        if (!held) throw new Error("NODE_VAULT_MISSING");
        args[1] = held;
      } else if (given.includes("{{profile.")) throw new Error("NODE_PLACEHOLDER_REFUSED");
    }
    const method = open.page[request.method] as (...values: unknown[]) => Promise<unknown>;
    // A failed method still answers with what was refused meanwhile: a navigation the guard aborted is why `open` failed.
    let value: unknown = null;
    let error: string | undefined;
    try { value = await method(...args); } catch (failure) { error = failure instanceof Error ? failure.message.slice(0, 300) : "NODE_FORM_FAILED"; }
    const answer: FormAnswer = { value: value ?? null, url: open.page.url(), closed: open.page.closed(), blocked: open.blocked.splice(0, open.blocked.length), ...(error ? { error } : {}) };
    // What the page shows back (a snapshot, a box's value, an address, an error) carries placeholders, never a held value.
    return redactHeld(answer, open.held);
  };
  /** The vault's two operations; the answer to a save is the hash of what reads back, so the server can check it without the value. */
  const vaultOp = async (request: Extract<BrowserOp, { op: "vaultPut" | "vaultRemove" }>): Promise<unknown> => {
    const vault = options.vault;
    if (!vault) throw new Error("NODE_VAULT_MISSING");
    const slot = String(request.slot);
    if (!VAULT_SLOT.test(slot)) throw new Error("NODE_VAULT_SLOT_INVALID");
    if (request.op === "vaultRemove") { await vault.remove(vaultName(slot)); form?.held.delete(slot); return { ok: true }; }
    const value = typeof request.value === "string" ? request.value : "";
    if (!value || value.length > 500) throw new Error("NODE_VAULT_VALUE_INVALID");
    await vault.write(vaultName(slot), value);
    const back = await vault.read(vaultName(slot)).catch(() => undefined);
    if (back === undefined) throw new Error("NODE_VAULT_UNREADABLE");
    return { sha256: vaultHash(back) };
  };
  const handle = async (request: BrowserOp): Promise<unknown> => {
    if (request.op === "vaultPut" || request.op === "vaultRemove") return vaultOp(request);
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
  return { available: Boolean(executable), vault: Boolean(options.vault), handle, formSubmitFromPhone, closeAll: async () => { await current?.driver.close(); current = undefined; await closeForm(); } };
}
export type NodeBrowsers = ReturnType<typeof createNodeBrowsers>;
