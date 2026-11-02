import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BrowserContext } from "playwright-core";
import { readerLaunch, restoreSessionCookies } from "./browser-launch";
import type { DriverTarget, FormDriver } from "./form-engine";
import type { NodeBrowserLink } from "./node/hub";
import { driveFormContext, publicHttpsOnly, type FormAnswer, type FormMethod } from "./node/browser";

export { onHosts, runHosts } from "./node/browser";

/**
 * The form engine's browser (docs/opportunity-agent.md §10.1–§10.2): a visible window of Crossline's own profile for this site, never the
 * person's everyday browser. The driver itself (`driveFormContext` in node/browser.ts) is shared with the compute node, so a hosted
 * owner's form is filled the same way in their own computer's browser (`openNodeFormBrowser`). No script of ours runs in the page.
 *
 * The network guard is ours, not the model's: a top-level navigation may go only to the run's own hosts; requests to private
 * addresses, popups and downloads are refused. Every refusal is reported to `onBlocked`. A fallback engine (§10.7) only proposes
 * actions, which the engine judges and does through this same driver.
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
export type FormBrowser = FormDriver & { context?: BrowserContext };

export async function openFormBrowser(options: FormBrowserOptions): Promise<FormBrowser> {
  const { chromium } = await import("playwright-core");
  mkdirSync(options.profileDir, { recursive: true });
  const launch = await readerLaunch(options.executablePath);
  const context = await chromium.launchPersistentContext(options.profileDir, { ...launch, acceptDownloads: false, ...(options.headless ? { headless: true } : {}) });
  await restoreSessionCookies(context, options.profileDir);
  const { picture, ...page } = await driveFormContext(context, { hosts: options.hosts, allow: options.allow ?? publicHttpsOnly(), onBlocked: options.onBlocked });
  return {
    ...page, context,
    screenshot: async (file, mask) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, await picture(mask)); }
  };
}

/**
 * The same driver in a browser on the owner's own computer, through a connected compute node (docs/opportunity-agent.md §10.1: a hosted
 * worker has no screen). The node keeps its own per-site profile and its own address rules (public https only); every answer carries the
 * page's address, whether it was closed and what the node refused, which go to `onBlocked` here. An upload is sent as the file's bytes.
 */
export async function openNodeFormBrowser(link: NodeBrowserLink, options: { host: string; hosts: string[]; onBlocked: (url: string, why: string) => void }): Promise<FormBrowser & { node: string }> {
  let url = "";
  let closed = false;
  const call = async (method: FormMethod, args: unknown[] = [], timeoutMs = 120_000): Promise<unknown> => {
    let answer: FormAnswer;
    try { answer = await link.call({ op: "form", method, args }, timeoutMs) as FormAnswer; }
    catch (error) {
      if (error instanceof Error && /NODE_DISCONNECTED|NODE_FORM_NOT_OPEN/.test(error.message)) closed = true;
      throw error;
    }
    url = answer.url;
    closed = answer.closed;
    for (const item of answer.blocked ?? []) options.onBlocked(item.url, item.why);
    if (answer.error) throw new Error(answer.error);
    return answer.value;
  };
  await link.call({ op: "formOpen", host: options.host, hosts: options.hosts }, 120_000);
  const target = (item: DriverTarget) => ({ ...(item.ref ? { ref: item.ref } : {}), role: item.role, name: item.name });
  return {
    node: link.host,
    open: async (address) => { await call("open", [address], 90_000); },
    url: () => url,
    snapshot: async () => String(await call("snapshot") ?? ""),
    signals: async () => (await call("signals")) as { passwordFields: number; frameUrls: string[]; required?: string[] },
    multiline: async () => ((await call("multiline")) as string[] | null) ?? [],
    inputValue: async (item, attempt) => { const value = await call("inputValue", [target(item), attempt]); return typeof value === "string" ? value : undefined; },
    fill: async (item, value, attempt) => { await call("fill", [target(item), value, attempt]); },
    select: async (item, option, attempt) => { await call("select", [target(item), option, attempt]); },
    check: async (item, on, attempt) => { await call("check", [target(item), on, attempt]); },
    upload: async (item, file, attempt) => { await call("upload", [target(item), { name: path.basename(file), data: readFileSync(file).toString("base64") }, attempt], 300_000); },
    click: async (item) => { await call("click", [target(item)]); },
    settle: async () => { await call("settle", [], 90_000); },
    screenshot: async (file, mask) => {
      const media = await link.call({ op: "formPicture", mask: mask.map(target) }, 120_000) as { bytes?: Buffer } | null;
      if (!media?.bytes) return;
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, media.bytes);
    },
    front: async () => { await call("front"); },
    closed: () => closed,
    close: async () => { closed = true; await link.call({ op: "formClose" }, 60_000).catch(() => undefined); }
  };
}
