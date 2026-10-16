import type { SkillTools } from "@crossline/codex";
import { workflowAccess, type GrownSkillRecord, type WorkflowAccess } from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";
import { ownerOf } from "./owner";
import { tOfWorkspace } from "./locale";

/**
 * Reading a site behind the person's login, done by Crossline and not by the assistant (docs/skills-library.md §8, decided 2026-10-14).
 * The first real run was told to be gentle and only read; it wrote its own scripts that opened every note and re-checked every link, and
 * the site answered with its security check over and over until the person stopped it. Rules in a prompt are not enforced; these are:
 *
 * - the assistant never gets the browser profile (the guard refuses its path); it calls `site_read` and gets the page's text and links;
 * - only the sites the workflow declared, each page once, a few pages a run and a day, with a pause between loads;
 * - a security check, a captcha or an unusual-traffic page closes the browser and stops every read of that site for two days
 *   (`site.breaker.<host>`), and the person is told; a page that sends to the login is a stop too, without the pause.
 *
 * There is no disguise here and none is to be added: the window is visible, the pace is a person's, and a check is a stop.
 */
export const SITE_PAGES_PER_RUN = 6;
export const SITE_PAGES_PER_DAY = 12;
export const SITE_BREAKER_HOURS = 48;
const PAUSE_MS: [number, number] = [6_000, 10_000];
const breakerKey = (host: string) => `site.breaker.${host}`;
const dayKey = (host: string, day: string) => `site.reads.${host}.${day}`;

// i18n-ignore-start: patterns matched against what a site shows
const CHECK_TEXT = /安全验证|请完成验证|验证码|滑块|拖动.{0,6}(滑块|完成)|访问异常|异常访问|请求过于频繁|操作频繁|captcha|verify you are (a )?human|unusual traffic|are you a robot|access denied/i;
const CHECK_URL = /captcha|verify|security-check|challenge|website-login\/(captcha|error)|\/(403|429)\b/i;
const LOGIN_URL = /\/login\b|website-login|passport|signin|sign-in/i;
const LOGIN_TEXT = /扫码登录|登录后查看|请先登录|登录后可|手机号登录/;
// i18n-ignore-end

/*
 * What the run is told to write as the first thing the person must do, in the workspace's language; the workflow reads it back from
 * `needsHuman` (written by the model, in either language) to tell the person what happened.
 */
// i18n-ignore-start: matched against what the model wrote, in either language
const LOGIN_NEEDED = /^(需要登录|Login needed|Log in needed|Sign-in needed)/i;
const CHECK_NEEDED = /^(需要本人完成|Security check needed|Needs you to complete)/i;
// i18n-ignore-end
export const isLoginNeeded = (text: string) => LOGIN_NEEDED.test(text.trim());
export const isCheckNeeded = (text: string) => CHECK_NEEDED.test(text.trim());

/** What the page showed, as the reader judges it: a check (stop the site), a login (stop the run's reads), or content. */
export function judgePage(url: string, title: string, text: string, status: number): "check" | "login" | "ok" {
  if (status === 429 || status === 461 || CHECK_URL.test(url) || CHECK_TEXT.test(`${title}\n${text.slice(0, 4000)}`)) return "check";
  if (LOGIN_URL.test(url) || (text.length < 3000 && LOGIN_TEXT.test(text))) return "login";
  return "ok";
}

const hostOf = (url: string) => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };
const sameSite = (url: string, access: WorkflowAccess) => { const host = hostOf(url), site = hostOf(access.site); return Boolean(host) && (host === site || host.endsWith(`.${site}`)); };
/** One page is one page whatever its tracking parameters say. */
const pageKey = (url: string) => { try { const parsed = new URL(url); return `${parsed.hostname}${parsed.pathname}`.replace(/\/+$/, "").toLowerCase(); } catch { return url; } };

type Browser = { read: (url: string, scrolls: number) => Promise<{ url: string; title: string; text: string; status: number; links: Array<{ text: string; href: string }> }>; close: () => Promise<void> };

/** The real browser: Playwright driving the browser the person logged in with, on its own profile, in a visible window. */
async function openBrowser(profileDir: string, executablePath: string): Promise<Browser> {
  const { chromium } = await import("playwright-core");
  const context = await chromium.launchPersistentContext(profileDir, { executablePath, headless: false, viewport: null,
    args: ["--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-background-mode"] });
  const page = context.pages()[0] ?? await context.newPage();
  return {
    async read(url, scrolls) {
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(3_000);
      for (let index = 0; index < scrolls; index += 1) { await page.mouse.wheel(0, 900); await page.waitForTimeout(2_500); }
      const shown = await page.evaluate(() => ({ title: document.title, text: (document.body?.innerText ?? "").slice(0, 20_000),
        links: [...document.querySelectorAll("a[href]")].slice(0, 400).map((anchor) => ({ text: (anchor.textContent ?? "").trim().slice(0, 120), href: (anchor as HTMLAnchorElement).href })) }));
      return { url: page.url(), status: response?.status() ?? 0, ...shown };
    },
    close: () => context.close().catch(() => undefined)
  };
}

export type SiteReader = { tools: SkillTools; close: () => Promise<void>; refusals: () => number; stopped: () => string | undefined };

/**
 * The `site_read` tool for one run of a workflow that reads accounts. `profileFor` gives each service's profile and browser; `notify`
 * tells the person a site was stopped at its check.
 */
export function createSiteReader(store: CrosslineStore, workspaceId: string, record: GrownSkillRecord,
  profileFor: (access: WorkflowAccess) => { dir: string; browser: string },
  deps: { open?: typeof openBrowser; now?: () => Date; sleep?: (ms: number) => Promise<void>; notify?: (text: string) => void } = {}): SiteReader {
  const sites = workflowAccess(record).access.filter((item) => item.login);
  const now = () => deps.now?.() ?? new Date();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const seen = new Set<string>();
  const browsers = new Map<string, Promise<Browser>>();
  let pages = 0, refused = 0, lastLoad = 0;
  let stoppedBy: string | undefined;
  const refuse = (text: string) => { refused += 1; return JSON.stringify({ ok: false, stop: true, message: text }); };
  const log = (host: string, url: string, outcome: string) => store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId,
    idempotencyKey: `site.read:${host}:${now().getTime()}:${Math.random().toString(36).slice(2, 8)}`, type: "site.read", entityId: record.id, payload: { host, url: url.slice(0, 300), outcome } });
  const closeSite = async (service: string) => { const open = browsers.get(service); browsers.delete(service); if (open) await (await open).close(); };

  const t = tOfWorkspace(store, workspaceId);
  // What the tool answers is read by the model, not the person: those sentences stay as they are (i18n-ignore on each).
  const call = async (name: string, args: unknown): Promise<string> => {
    if (name !== "site_read") return refuse(`没有名为 ${name} 的工具`); // i18n-ignore: model-facing
    const { service = "", url = "", scrolls = 0 } = (args ?? {}) as { service?: string; url?: string; scrolls?: number };
    const access = sites.find((item) => item.service === service) ?? sites.find((item) => sameSite(String(url), item));
    if (!access) return refuse(`这个工作流只读取：${sites.map((item) => item.service).join("、") || "（无需要登录的网站）"}`); // i18n-ignore: model-facing
    if (!sameSite(String(url), access)) return refuse(`只能打开 ${access.site} 上的页面`); // i18n-ignore: model-facing
    const host = hostOf(access.site);
    const until = store.getSetting(workspaceId, breakerKey(host));
    if (stoppedBy || (until && Date.parse(until) > now().getTime())) return refuse(`${access.service} 已暂停读取${until ? `至 ${until.slice(0, 16).replace("T", " ")}` : ""}：之前遇到了安全验证。用已读到的内容完成本期，不要再读。`); // i18n-ignore: model-facing
    const key = pageKey(String(url));
    if (seen.has(key)) return refuse("这个页面本期已经读过；每个页面只读一次，用上次读到的内容。"); // i18n-ignore: model-facing
    if (pages >= SITE_PAGES_PER_RUN) return refuse(`本期最多读 ${SITE_PAGES_PER_RUN} 个页面，已用完；用已读到的内容完成本期。`); // i18n-ignore: model-facing
    const day = now().toISOString().slice(0, 10);
    const today = Number(store.getSetting(workspaceId, dayKey(host, day)) ?? 0);
    if (today >= SITE_PAGES_PER_DAY) return refuse(`今天已读 ${today} 个 ${access.service} 页面，到了每日上限；明天再读。`); // i18n-ignore: model-facing
    seen.add(key);
    pages += 1;
    store.setSetting(workspaceId, dayKey(host, day), String(today + 1));
    const wait = lastLoad ? Math.max(0, lastLoad + PAUSE_MS[0] + Math.random() * (PAUSE_MS[1] - PAUSE_MS[0]) - Date.now()) : 0;
    if (wait) await sleep(wait);
    let shown;
    try {
      if (!browsers.has(access.service)) { const profile = profileFor(access); browsers.set(access.service, (deps.open ?? openBrowser)(profile.dir, profile.browser)); }
      shown = await (await browsers.get(access.service)!).read(String(url), Math.max(0, Math.min(5, Math.floor(Number(scrolls) || 0))));
    } catch (error) {
      log(host, String(url), "failed");
      await closeSite(access.service);
      return refuse(`打不开这个页面：${error instanceof Error ? error.message.slice(0, 200) : "浏览器出错"}。不要换方式重试。`); // i18n-ignore: model-facing
    } finally { lastLoad = Date.now(); }
    const verdict = judgePage(shown.url, shown.title, shown.text, shown.status);
    log(host, shown.url, verdict);
    if (verdict === "check") {
      stoppedBy = t("需要本人完成{{service}}安全验证", { service: access.service });
      const resume = new Date(now().getTime() + SITE_BREAKER_HOURS * 3_600_000).toISOString();
      store.setSetting(workspaceId, breakerKey(host), resume);
      await closeSite(access.service);
      deps.notify?.(t("读取{{service}}时遇到了安全验证，已立刻停下并关闭浏览器，{{hours}} 小时内不再读取。请本人在手机或常用浏览器里正常使用；已读到的内容照常整理。", { service: access.service, hours: SITE_BREAKER_HOURS }));
      return refuse(`${access.service} 出现了安全验证，已停止读取。用已读到的内容完成本期，needsHuman 第一项写「${stoppedBy}」。`); // i18n-ignore: model-facing
    }
    if (verdict === "login") {
      stoppedBy = t("需要登录：{{service}}", { service: access.service });
      await closeSite(access.service);
      return refuse(`${access.service} 要求登录，已停止读取。needsHuman 第一项写「${stoppedBy}」。`); // i18n-ignore: model-facing
    }
    const links = shown.links.filter((link) => sameSite(link.href, access) && link.text).slice(0, 150);
    return JSON.stringify({ ok: true, url: shown.url, title: shown.title, text: shown.text, links, pagesLeft: SITE_PAGES_PER_RUN - pages });
  };

  return {
    tools: { specs: sites.length ? [{ name: "site_read", description: `打开${sites.map((item) => item.service).join("、")}上的一个页面并返回它显示的文字和链接（本人已登录）。只读；每个页面只读一次；本期最多 ${SITE_PAGES_PER_RUN} 页；遇到安全验证或要求登录会停止。不要逐条打开详情页。`, // i18n-ignore: model-facing
      inputSchema: { type: "object", properties: { service: { type: "string", description: "网站名，例如 小红书" }, url: { type: "string", description: "要打开的页面地址" }, // i18n-ignore: model-facing
        scrolls: { type: "integer", minimum: 0, maximum: 5, description: "打开后向下滚动几屏以加载更多（列表页用）" } }, required: ["service", "url"], additionalProperties: false } }] : [], call }, // i18n-ignore: model-facing
    close: async () => { await Promise.all([...browsers.keys()].map(closeSite)); },
    refusals: () => refused,
    stopped: () => stoppedBy
  };
}
