import type { SkillTools } from "@crossline/codex";
import { workflowAccess, type GrownSkillRecord, type WorkflowAccess } from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";
import { ownerOf } from "./owner";

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

const CHECK_TEXT = /安全验证|请完成验证|验证码|滑块|拖动.{0,6}(滑块|完成)|访问异常|异常访问|请求过于频繁|操作频繁|captcha|verify you are (a )?human|unusual traffic|are you a robot|access denied/i;
const CHECK_URL = /captcha|verify|security-check|challenge|website-login\/(captcha|error)|\/(403|429)\b/i;
const LOGIN_URL = /\/login\b|website-login|passport|signin|sign-in/i;
const LOGIN_TEXT = /扫码登录|登录后查看|请先登录|登录后可|手机号登录/;

/** What the page showed, as the reader judges it: a check (stop the site), a login (stop the run's reads), or content. */
export function judgePage(url: string, title: string, text: string, status: number): "check" | "login" | "ok" {
  if (status === 429 || status === 461 || CHECK_URL.test(url) || CHECK_TEXT.test(`${title}\n${text.slice(0, 4000)}`)) return "check";
  if (LOGIN_URL.test(url) || (text.length < 3000 && LOGIN_TEXT.test(text))) return "login";
  return "ok";
}

const hostOf = (url: string) => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };
const sameSite = (url: string, access: WorkflowAccess) => { const host = hostOf(url), site = hostOf(access.site); return Boolean(host) && (host === site || host.endsWith(`.${site}`)); };

/** Parameters that only say where a click came from or carry a session's token: two addresses differing in these are one page. */
const TRACKING = /^(utm_\w+|xsec_token|xsec_source|spm|share_\w+|app_platform|app_version|source|from|ref|si|fbclid|gclid|_t|t)$/i;
/**
 * One page is one page whatever its tracking parameters say, but another tab or another search on the same path is another page
 * (2026-10-19: the key used to drop the whole query, so `?tab=fav` after the profile read as a page already read). The query stays,
 * normalized: tracking parameters dropped, the rest sorted, no fragment, no trailing slash, no `www.`.
 */
export const pageKey = (url: string): string => {
  try {
    const parsed = new URL(url);
    const query = [...parsed.searchParams.entries()].filter(([name]) => !TRACKING.test(name))
      .sort(([a, x], [b, y]) => a.localeCompare(b) || x.localeCompare(y))
      .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join("&");
    return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname.replace(/\/+$/, "")}`.toLowerCase() + (query ? `?${query}` : "");
  } catch { return url; }
};

/** How far a list page may be scrolled to load more (it stops sooner once two screens bring nothing new), and how much comes back. */
export const SITE_SCROLLS_MAX = 15;
const TEXT_MAX = 60_000;
const LINKS_MAX = 1_500;
const LINKS_RETURNED = 600;
const CLICK_LABEL_MAX = 12;
/**
 * A click is only a switch to another tab of the same page (个人页的「收藏」「专辑」「笔记」). A label naming anything that changes the
 * account, sends, buys or leaves is refused before the browser is touched; the page then has to show the label as a tab (`pickTab`).
 */
const CLICK_FORBIDDEN = /关注|点赞|取消|删除|移除|清空|发布|发表|评论|回复|私信|消息|购买|下单|支付|付款|充值|分享|转发|举报|拉黑|屏蔽|编辑|修改|设置|退出|注销|登出|保存|提交|发送|上传|订阅|加入|申请|移动|新建|创建|\b(follow|unfollow|like|delete|remove|post|publish|comment|reply|message|buy|pay|share|report|block|edit|settings|logout|log out|sign out|save|submit|send|upload|subscribe|join)\b/i;

/** Why a label may not be clicked, or undefined when it may. */
export function clickProblem(label: string): string | undefined {
  const text = label.replace(/\s+/g, " ").trim();
  if (!text) return "要点击的标签文字是空的";
  if (text.length > CLICK_LABEL_MAX) return `只能点页面内的短标签（${CLICK_LABEL_MAX} 个字以内），例如「收藏」「专辑」「笔记」`;
  if (CLICK_FORBIDDEN.test(text)) return `「${text}」会改动账号或离开页面，不能点；只能切换到「收藏」「专辑」「笔记」这类只读标签`;
  return undefined;
}

/** A page saying itself that its list is empty: the site's own words outrank the count of links. */
const EMPTY_TEXT = /还没有.{0,10}(收藏|内容|笔记|作品|动态|专辑)|暂无.{0,6}(收藏|内容|笔记|数据|作品)|空空如也|nothing (here|to see)|no (saved|items|posts|results)( yet)?\b/i;
const ID_SEGMENT = /^(?=[^/]*\d)[a-z0-9_-]{8,}$/i;

/**
 * The items a list page shows: distinct links on the site whose path names one thing by an id (a note, a video, a post), other than the
 * page itself. Navigation (/explore, /notification) names no id, so a favourites tab with nothing in it counts none — which is how a run
 * that read an empty page is told apart from one that read the person's list (docs/skills-library.md §8).
 */
export function itemLinks(links: Array<{ href: string }>, pageUrl: string, onSite: (href: string) => boolean): string[] {
  const own = (() => { try { return new URL(pageUrl).pathname.replace(/\/+$/, "").toLowerCase(); } catch { return ""; } })();
  const found = new Set<string>();
  for (const link of links) {
    if (!onSite(link.href)) continue;
    let parsed: URL;
    try { parsed = new URL(link.href); } catch { continue; }
    const pathName = parsed.pathname.replace(/\/+$/, "").toLowerCase();
    if (pathName === own || !pathName.split("/").some((segment) => ID_SEGMENT.test(segment))) continue;
    found.add(`${parsed.hostname.replace(/^www\./, "")}${pathName}`);
  }
  return [...found];
}

type Link = { text: string; href: string };
/** A visible element whose text is the label, as the page describes it: whether it sits in a tab strip, links somewhere, or is a form control. */
export type TabCandidate = { text: string; tabLike: boolean; href: string; control: boolean };
/** The few things reading a page needs from a browser: the real one is Playwright (`playwrightDriver`), tests give their own. */
export type PageDriver = {
  goto: (url: string) => Promise<number>;
  pause: (ms: number) => Promise<void>;
  wheel: () => Promise<void>;
  snapshot: () => Promise<{ url: string; title: string; text: string; links: Link[] }>;
  tabs: (label: string) => Promise<TabCandidate[]>;
  clickTab: (index: number) => Promise<void>;
};
export type PageRead = { url: string; title: string; text: string; status: number; links: Link[]; click?: { label: string; done: boolean; why?: string } };

/** The tab to click for a label: one in a tab strip, not a form control, not a link off the site. */
export function pickTab(candidates: TabCandidate[], label: string, onSite: (href: string) => boolean): { index: number } | { why: string } {
  const index = candidates.findIndex((item) => item.tabLike && !item.control && (!item.href || onSite(item.href)));
  if (index >= 0) return { index };
  return { why: candidates.length ? `页面上的「${label}」不是页面内的标签（是按钮、表单或站外链接），没有点` : `页面上没有「${label}」这个标签` };
}

/** A later screen's lines added to what was read: the overlap with the end of what came before is skipped; a list that unloaded what scrolled away is joined. */
function mergeLines(read: string[], next: string[], seen: Set<string>): number {
  for (let start = 0; start < read.length; start += 1) {
    if (read[start] !== next[0]) continue;
    const overlap = read.length - start;
    if (overlap > next.length || !next.slice(0, overlap).every((line, index) => line === read[start + index])) continue;
    const added = next.slice(overlap);
    for (const line of added) { read.push(line); seen.add(line); }
    return added.length;
  }
  let added = 0;
  for (const line of next) if (!seen.has(line)) { read.push(line); seen.add(line); added += 1; }
  return added;
}

/**
 * Reads one page: opens it, switches to the tab named by `click` (a tab of this page only; ending up off the site is an error, and the
 * caller closes the browser), then scrolls until two screens in a row bring nothing new or `scrolls` is reached, keeping every line and
 * link seen on the way, so a list that unloads what scrolled away is still read whole.
 */
export async function readPage(driver: PageDriver, url: string, options: { scrolls: number; click?: string; onSite: (href: string) => boolean }): Promise<PageRead> {
  const status = await driver.goto(url);
  await driver.pause(3_000);
  let click: PageRead["click"];
  if (options.click) {
    const picked = pickTab(await driver.tabs(options.click), options.click, options.onSite);
    if ("index" in picked) {
      await driver.clickTab(picked.index);
      await driver.pause(2_500);
      click = { label: options.click, done: true };
    } else click = { label: options.click, done: false, why: picked.why };
  }
  let shown = await driver.snapshot();
  if (!options.onSite(shown.url)) throw new Error("点击后离开了这个网站，已停下");
  const lines: string[] = [], seen = new Set<string>();
  const links = new Map<string, Link>();
  const take = (snap: typeof shown) => {
    let added = mergeLines(lines, snap.text.split("\n").map((line) => line.trim()).filter(Boolean), seen);
    for (const link of snap.links) if (!links.has(link.href) && links.size < LINKS_MAX) { links.set(link.href, link); added += 1; }
    return added;
  };
  take(shown);
  for (let index = 0, quiet = 0; index < options.scrolls && quiet < 2 && lines.join("\n").length < TEXT_MAX; index += 1) {
    await driver.wheel();
    await driver.pause(2_500);
    shown = await driver.snapshot();
    if (!options.onSite(shown.url)) throw new Error("滚动时离开了这个网站，已停下");
    quiet = take(shown) ? 0 : quiet + 1;
  }
  return { url: shown.url, title: shown.title, status, text: lines.join("\n").slice(0, TEXT_MAX), links: [...links.values()], ...(click ? { click } : {}) };
}

export type SiteBrowser = { read: (url: string, scrolls: number, click?: string) => Promise<PageRead>; close: () => Promise<void> };

/** Playwright's page as a `PageDriver`: the DOM is read in the page, and a tab is clicked the way a person clicks it. */
function playwrightDriver(page: import("playwright-core").Page): PageDriver {
  return {
    goto: async (url) => (await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }))?.status() ?? 0,
    pause: (ms) => page.waitForTimeout(ms),
    wheel: () => page.mouse.wheel(0, 900),
    snapshot: async () => ({ url: page.url(), ...(await page.evaluate(([textMax, linksMax]) => ({ title: document.title, text: (document.body?.innerText ?? "").slice(0, textMax),
      links: [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].filter((anchor) => anchor.getClientRects().length).slice(0, linksMax)
        .map((anchor) => ({ text: (anchor.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120), href: anchor.href })) }), [TEXT_MAX, LINKS_MAX] as const)) }),
    tabs: (label) => page.evaluate((wanted) => {
      document.querySelectorAll("[data-crossline-tab]").forEach((element) => element.removeAttribute("data-crossline-tab"));
      const norm = (value: string) => value.replace(/\s+/g, " ").trim();
      const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`^${escaped}\\s*[·•]?\\s*\\d*$`);
      const all = [...document.querySelectorAll<HTMLElement>("body *")].filter((element) => element.getClientRects().length && pattern.test(norm(element.innerText ?? "")));
      const deepest = all.filter((element) => !all.some((other) => other !== element && element.contains(other)));
      return deepest.slice(0, 20).map((element, index) => {
        element.setAttribute("data-crossline-tab", String(index));
        let tabLike = false;
        for (let node: HTMLElement | null = element, depth = 0; node && depth < 5 && !tabLike; node = node.parentElement, depth += 1)
          tabLike = /^(tab|tablist)$/.test(node.getAttribute("role") ?? "") || node.hasAttribute("aria-selected") || /tab(?!le)/i.test(String(node.className ?? ""));
        return { text: norm(element.innerText ?? ""), tabLike, href: element.closest<HTMLAnchorElement>("a[href]")?.href ?? "",
          control: Boolean(element.closest("form, input, textarea, select, button[type=submit]")) };
      });
    }, label),
    clickTab: (index) => page.click(`[data-crossline-tab="${index}"]`, { timeout: 5_000 })
  };
}

/** Opens the browser for one site: tests give their own, which never starts a real browser. */
export type OpenSite = (profileDir: string, executablePath: string, onSite: (href: string) => boolean) => Promise<SiteBrowser>;

/** The real browser: Playwright driving the browser the person logged in with, on its own profile, in a visible window. */
const openBrowser: OpenSite = async (profileDir, executablePath, onSite) => {
  const { chromium } = await import("playwright-core");
  const context = await chromium.launchPersistentContext(profileDir, { executablePath, headless: false, viewport: null,
    args: ["--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-background-mode"] });
  const driver = playwrightDriver(context.pages()[0] ?? await context.newPage());
  return {
    read: (url, scrolls, click) => readPage(driver, url, { scrolls, onSite, ...(click ? { click } : {}) }),
    close: () => context.close().catch(() => undefined)
  };
};

/** What a run's reads found: how many distinct items the pages showed, and the pages that showed some (with the tab clicked to get there). */
export type SiteFound = { items: number; pages: Array<{ url: string; click?: string }> };
export type SiteReader = { tools: SkillTools; close: () => Promise<void>; refusals: () => number; stopped: () => string | undefined; found: () => SiteFound };

/**
 * The `site_read` tool for one run of a workflow that reads accounts. `profileFor` gives each service's profile and browser; `notify`
 * tells the person a site was stopped at its check.
 */
export function createSiteReader(store: CrosslineStore, workspaceId: string, record: GrownSkillRecord,
  profileFor: (access: WorkflowAccess) => { dir: string; browser: string },
  deps: { open?: OpenSite; now?: () => Date; sleep?: (ms: number) => Promise<void>; notify?: (text: string) => void } = {}): SiteReader {
  const sites = workflowAccess(record).access.filter((item) => item.login);
  const now = () => deps.now?.() ?? new Date();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const seen = new Set<string>();
  const browsers = new Map<string, Promise<SiteBrowser>>();
  const runItems = new Set<string>();
  const shownPages: Array<{ url: string; click?: string; key: string }> = [];
  let pages = 0, refused = 0, lastLoad = 0;
  let stoppedBy: string | undefined;
  const refuse = (text: string) => { refused += 1; return JSON.stringify({ ok: false, stop: true, message: text }); };
  const log = (host: string, url: string, outcome: string) => store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId,
    idempotencyKey: `site.read:${host}:${now().getTime()}:${Math.random().toString(36).slice(2, 8)}`, type: "site.read", entityId: record.id, payload: { host, url: url.slice(0, 300), outcome } });
  const closeSite = async (service: string) => { const open = browsers.get(service); browsers.delete(service); if (open) await (await open).close(); };

  const call = async (name: string, args: unknown): Promise<string> => {
    if (name !== "site_read") return refuse(`没有名为 ${name} 的工具`);
    const { service = "", url = "", scrolls = 0, click = "" } = (args ?? {}) as { service?: string; url?: string; scrolls?: number; click?: string };
    const access = sites.find((item) => item.service === service) ?? sites.find((item) => sameSite(String(url), item));
    if (!access) return refuse(`这个工作流只读取：${sites.map((item) => item.service).join("、") || "（无需要登录的网站）"}`);
    if (!sameSite(String(url), access)) return refuse(`只能打开 ${access.site} 上的页面`);
    const label = String(click ?? "").replace(/\s+/g, " ").trim();
    const clickRefused = label ? clickProblem(label) : undefined;
    if (clickRefused) return refuse(`${clickRefused}。`);
    const host = hostOf(access.site);
    const until = store.getSetting(workspaceId, breakerKey(host));
    if (stoppedBy || (until && Date.parse(until) > now().getTime())) return refuse(`${access.service} 已暂停读取${until ? `至 ${until.slice(0, 16).replace("T", " ")}` : ""}：之前遇到了安全验证。用已读到的内容完成本期，不要再读。`);
    // The same page with another tab clicked is another page.
    const key = pageKey(String(url)) + (label ? `#${label}` : "");
    if (seen.has(key)) return refuse("这个页面本期已经读过；每个页面只读一次，用上次读到的内容。");
    if (pages >= SITE_PAGES_PER_RUN) return refuse(`本期最多读 ${SITE_PAGES_PER_RUN} 个页面，已用完；用已读到的内容完成本期。`);
    const day = now().toISOString().slice(0, 10);
    const today = Number(store.getSetting(workspaceId, dayKey(host, day)) ?? 0);
    if (today >= SITE_PAGES_PER_DAY) return refuse(`今天已读 ${today} 个 ${access.service} 页面，到了每日上限；明天再读。`);
    seen.add(key);
    pages += 1;
    store.setSetting(workspaceId, dayKey(host, day), String(today + 1));
    const wait = lastLoad ? Math.max(0, lastLoad + PAUSE_MS[0] + Math.random() * (PAUSE_MS[1] - PAUSE_MS[0]) - Date.now()) : 0;
    if (wait) await sleep(wait);
    const onSite = (href: string) => sameSite(href, access);
    let shown: PageRead;
    try {
      if (!browsers.has(access.service)) { const profile = profileFor(access); browsers.set(access.service, (deps.open ?? openBrowser)(profile.dir, profile.browser, onSite)); }
      shown = await (await browsers.get(access.service)!).read(String(url), Math.max(0, Math.min(SITE_SCROLLS_MAX, Math.floor(Number(scrolls) || 0))), label || undefined);
    } catch (error) {
      log(host, String(url), "failed");
      await closeSite(access.service);
      return refuse(`打不开这个页面：${error instanceof Error ? error.message.slice(0, 200) : "浏览器出错"}。不要换方式重试。`);
    } finally { lastLoad = Date.now(); }
    const verdict = judgePage(shown.url, shown.title, shown.text, shown.status);
    log(host, shown.url, verdict);
    if (verdict === "check") {
      stoppedBy = `需要本人完成${access.service}安全验证`;
      const resume = new Date(now().getTime() + SITE_BREAKER_HOURS * 3_600_000).toISOString();
      store.setSetting(workspaceId, breakerKey(host), resume);
      await closeSite(access.service);
      deps.notify?.(`读取${access.service}时遇到了安全验证，已立刻停下并关闭浏览器，${SITE_BREAKER_HOURS} 小时内不再读取。请本人在手机或常用浏览器里正常使用；已读到的内容照常整理。`);
      return refuse(`${access.service} 出现了安全验证，已停止读取。用已读到的内容完成本期，needsHuman 第一项写「${stoppedBy}」。`);
    }
    if (verdict === "login") {
      stoppedBy = `需要登录：${access.service}`;
      await closeSite(access.service);
      return refuse(`${access.service} 要求登录，已停止读取。needsHuman 第一项写「${stoppedBy}」。`);
    }
    const empty = EMPTY_TEXT.test(shown.text.slice(0, 20_000));
    const items = empty ? [] : itemLinks(shown.links, shown.url, onSite);
    for (const item of items) runItems.add(item);
    const clicked = label && shown.click?.done ? label : undefined;
    if (items.length && !shownPages.some((page) => page.key === key)) shownPages.push({ url: String(url), ...(clicked ? { click: clicked } : {}), key });
    const links = shown.links.filter((link) => onSite(link.href) && (link.text || itemLinks([link], shown.url, onSite).length)).slice(0, LINKS_RETURNED);
    return JSON.stringify({ ok: true, url: shown.url, title: shown.title, text: shown.text, links, items: items.length,
      ...(empty || !items.length ? { empty: true, note: "这个页面上没有列出条目：可能列表本来为空、标签没切过去、登录已失效或页面改版了。" } : {}),
      ...(shown.click ? { click: shown.click } : {}), pagesLeft: SITE_PAGES_PER_RUN - pages });
  };

  return {
    tools: { specs: sites.length ? [{ name: "site_read", description: `打开${sites.map((item) => item.service).join("、")}上的一个页面并返回它显示的文字和链接（本人已登录）。只读；每个页面只读一次（同一页面点不同标签算不同页面）；本期最多 ${SITE_PAGES_PER_RUN} 页；遇到安全验证或要求登录会停止。列表在页面内的标签下时用 click 切换过去，用 scrolls 加载更多；不要逐条打开详情页。`,
      inputSchema: { type: "object", properties: { service: { type: "string", description: "网站名，例如 小红书" }, url: { type: "string", description: "要打开的页面地址" },
        click: { type: "string", description: "打开后要点击的页面内标签的文字，例如 收藏、专辑、笔记；只能是只读的标签切换，不能是关注、点赞、取消、删除、发布、评论、私信、购买这类按钮" },
        scrolls: { type: "integer", minimum: 0, maximum: SITE_SCROLLS_MAX, description: `打开（并切换标签）后向下滚动最多几屏以加载更多；连续两屏没有新内容就停（列表页用，最多 ${SITE_SCROLLS_MAX}）` } },
        required: ["service", "url"], additionalProperties: false } }] : [], call },
    close: async () => { await Promise.all([...browsers.keys()].map(closeSite)); },
    refusals: () => refused,
    stopped: () => stoppedBy,
    found: () => ({ items: runItems.size, pages: shownPages.map(({ url, click }) => ({ url, ...(click ? { click } : {}) })) })
  };
}
