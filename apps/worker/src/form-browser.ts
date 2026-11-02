import { mkdirSync } from "node:fs";
import path from "node:path";
import type { BrowserContext, Locator, Page } from "playwright-core";
import { parseAriaSnapshot } from "@crossline/core";
import { readerLaunch, restoreSessionCookies } from "./browser-launch";
import type { DriverTarget, FormDriver } from "./form-engine";
import { publicHttpsOnly } from "./node/browser";

/**
 * The form engine's browser (docs/opportunity-agent.md §10.1–§10.2): a visible window of Crossline's own profile for this site, never the
 * person's everyday browser. Everything is read through the accessibility snapshot and Playwright's locators, which run in Playwright's
 * own isolated world: no script of ours runs in the page, and no debugging port is opened.
 *
 * The network guard is ours, not the model's: a top-level navigation may go only to the run's own hosts; requests to private
 * addresses, popups and downloads are refused. Every refusal is reported to `onBlocked`. A fallback engine (§10.7) only proposes
 * actions, which the engine judges and does through this same driver, so it never drives the page itself.
 */
export type FormBrowserOptions = {
  profileDir: string;
  executablePath: string;
  /** Hosts a top-level navigation may reach (the registration host and its known aliases). */
  hosts: string[];
  onBlocked: (url: string, why: string) => void;
  /** Where requests may go at all; the default refuses private addresses and anything but https (a test page passes its own). */
  allow?: (url: string) => Promise<boolean>;
  /** A test opens a headless window. */
  headless?: boolean;
};
export type FormBrowser = FormDriver & { context: BrowserContext; page: () => Page };

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

export async function openFormBrowser(options: FormBrowserOptions): Promise<FormBrowser> {
  const { chromium } = await import("playwright-core");
  mkdirSync(options.profileDir, { recursive: true });
  const launch = await readerLaunch(options.executablePath);
  const context = await chromium.launchPersistentContext(options.profileDir, { ...launch, acceptDownloads: false, ...(options.headless ? { headless: true } : {}) });
  await restoreSessionCookies(context, options.profileDir);
  const allow = options.allow ?? publicHttpsOnly();
  let current = context.pages()[0] ?? await context.newPage();
  // No second tab: a page that opens one gets it closed at once (§10.2: 不跨标签页).
  context.on("page", (page) => { if (page !== current) { options.onBlocked(page.url(), "popup"); void page.close().catch(() => undefined); } });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = request.url();
    const top = request.isNavigationRequest() && request.frame() === current.mainFrame();
    if (!(await allow(url))) { options.onBlocked(url, "address"); return route.abort("blockedbyclient"); }
    if (top && !onHosts(url, options.hosts)) { options.onBlocked(url, "host"); return route.abort("blockedbyclient"); }
    return route.continue();
  });

  const locate = (target: DriverTarget, attempt: number): Locator => {
    if (attempt === 0 && target.ref) return current.locator(`aria-ref=${target.ref}`);
    if (attempt <= 1) return current.getByRole(target.role as Parameters<Page["getByRole"]>[0], { name: target.name, exact: true }).first();
    return current.getByLabel(target.name, { exact: true }).first();
  };

  return {
    context, page: () => current,
    open: async (url) => { await current.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }); },
    url: () => current.url(),
    snapshot: () => current.ariaSnapshot({ mode: "ai" }),
    signals: async () => ({ passwordFields: await current.locator("input[type=password]:visible").count().catch(() => 0), frameUrls: current.frames().map((frame) => frame.url()) }),
    multiline: async () => {
      const names: string[] = [];
      for (const area of await current.locator("textarea").all().catch(() => [] as Locator[])) {
        const node = parseAriaSnapshot(await area.ariaSnapshot().catch(() => ""))[0];
        if (node?.name) names.push(node.name);
      }
      return names;
    },
    inputValue: async (target, attempt) => { return locate(target, attempt).inputValue({ timeout: 3_000 }).catch(() => undefined); },
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
    screenshot: async (file, mask) => {
      mkdirSync(path.dirname(file), { recursive: true });
      const masked = mask.map((target) => current.getByRole(target.role as Parameters<Page["getByRole"]>[0], { name: target.name, exact: true }));
      await current.screenshot({ path: file, fullPage: true, mask: masked, timeout: 15_000 });
    },
    front: async () => { await current.bringToFront(); },
    closed: () => current.isClosed(),
    close: async () => { await context.close().catch(() => undefined); }
  };
}
