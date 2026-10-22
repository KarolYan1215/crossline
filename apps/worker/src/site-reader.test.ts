import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import type { GrownSkillRecord } from "@crossline/core";
import { clickProblem, createSiteReader, itemLinks, judgePage, pageKey, readPage, SITE_BREAKER_HOURS, SITE_PAGES_PER_RUN, SITE_SCROLLS_MAX, type PageDriver, type TabCandidate } from "./site-reader";
import { loopReason } from "./agent-task";

let store: CrosslineStore;
let ws: string;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  ws = store.createPrincipalWithWorkspace("user-1", "个人 workspace").workspace.id;
});
afterEach(() => store.close());

const record = { id: "flow-xhs", manifest: { access: [{ service: "小红书", site: "https://www.xiaohongshu.com/", login: true, how: "收藏页" }], risks: ["r"] } } as unknown as GrownSkillRecord;
type Page = { url: string; title: string; text: string; status: number; links: Array<{ text: string; href: string }> };
function reader(pages: (url: string, click?: string) => Page, now = new Date("2026-10-15T15:00:00Z")) {
  const opened: string[] = [];
  const calls: Array<{ url: string; scrolls: number; click?: string }> = [];
  const told: string[] = [];
  let closed = 0;
  const site = createSiteReader(store, ws, record, () => ({ dir: "C:\\p", browser: "chrome.exe" }), {
    now: () => now, sleep: async () => {}, notify: (text) => told.push(text),
    open: async () => ({ read: async (url, scrolls, click) => { opened.push(url); calls.push({ url, scrolls, ...(click ? { click } : {}) }); return pages(url, click); },
      close: async () => { closed += 1; } })
  });
  const read = async (url: string, extra: { click?: string; scrolls?: number } = {}) =>
    JSON.parse(await site.tools.call("site_read", { service: "小红书", url, ...extra })) as { ok: boolean; message?: string; text?: string; items?: number; empty?: boolean; links?: unknown[] };
  return { site, read, opened, calls, told, closed: () => closed };
}
const content = (url: string): Page => ({ url, title: "收藏", text: "笔记 A\n笔记 B", status: 200, links: [{ text: "笔记 A", href: "https://www.xiaohongshu.com/explore/1" }, { text: "外站", href: "https://evil.example/x" }] });

test("each page once, only the declared site, and a budget per run", async () => {
  const { read, opened } = reader(content);
  expect(await read("https://www.xiaohongshu.com/user/profile/me?tab=fav")).toMatchObject({ ok: true, text: "笔记 A\n笔记 B" });
  // Tracking parameters and their order do not make another page.
  expect(await read("https://www.xiaohongshu.com/user/profile/me/?xsec_token=abc&tab=fav&utm_source=share#top")).toMatchObject({ ok: false });
  expect(await read("https://evil.example/")).toMatchObject({ ok: false });
  for (let index = 2; index <= SITE_PAGES_PER_RUN; index += 1) expect((await read(`https://www.xiaohongshu.com/explore/${index}`)).ok).toBe(true);
  expect(await read("https://www.xiaohongshu.com/explore/99")).toMatchObject({ ok: false, message: expect.stringContaining("已用完") });
  expect(opened).toHaveLength(SITE_PAGES_PER_RUN);
});

test("a security check closes the browser, stops the site for two days and tells the person; nothing more is opened", async () => {
  const now = new Date("2026-10-15T15:00:00Z");
  const first = reader((url) => url.includes("explore") ? { ...content(url), title: "安全验证", text: "请完成验证后继续访问" } : content(url), now);
  expect((await first.read("https://www.xiaohongshu.com/user/profile/me")).ok).toBe(true);
  expect(await first.read("https://www.xiaohongshu.com/explore/1")).toMatchObject({ ok: false, message: expect.stringContaining("需要本人完成小红书安全验证") });
  expect(first.closed()).toBe(1);
  expect(first.told[0]).toContain(`${SITE_BREAKER_HOURS} 小时内不再读取`);
  expect(await first.read("https://www.xiaohongshu.com/explore/2")).toMatchObject({ ok: false });
  expect(first.site.stopped()).toBe("需要本人完成小红书安全验证");
  expect(first.site.refusals()).toBe(2);
  // The next run, a day later, is refused before any browser opens.
  const next = reader(content, new Date(now.getTime() + 24 * 3_600_000));
  expect(await next.read("https://www.xiaohongshu.com/user/profile/me")).toMatchObject({ ok: false, message: expect.stringContaining("已暂停读取") });
  expect(next.opened).toEqual([]);
});

test("the page is judged by what it shows: a check, a login, or content", () => {
  expect(judgePage("https://www.xiaohongshu.com/website-login/captcha?x=1", "", "", 200)).toBe("check");
  expect(judgePage("https://www.xiaohongshu.com/explore", "小红书", "", 461)).toBe("check");
  expect(judgePage("https://www.xiaohongshu.com/login", "登录", "扫码登录", 200)).toBe("login");
  expect(judgePage("https://www.xiaohongshu.com/user/profile/me", "我的", "收藏 · 笔记 1 · 笔记 2", 200)).toBe("ok");
});

test("a run going round in circles is named: the same command four times, or three refused reads", () => {
  const run = (command: string) => ({ command });
  expect(loopReason([run("python a.py"), run("python  a.py"), run("python a.py")], 0)).toBeUndefined();
  expect(loopReason([run("python a.py"), run("python a.py"), run("python a.py"), run("python a.py")], 0)).toBe("同一条命令重复执行了 4 次");
  expect(loopReason([run("ls")], 3)).toBe("读取网站被拒绝了 3 次仍在继续尝试");
});

test("a page's key keeps its tab and search but not its tracking: another tab is another page", () => {
  const fav = pageKey("https://www.xiaohongshu.com/user/profile/me?tab=fav");
  expect(pageKey("https://xiaohongshu.com/user/profile/me/?xsec_source=pc&tab=fav&xsec_token=AB#notes")).toBe(fav);
  expect(pageKey("https://www.xiaohongshu.com/user/profile/me?tab=note")).not.toBe(fav);
  expect(pageKey("https://www.xiaohongshu.com/user/profile/me")).not.toBe(fav);
  expect(pageKey("https://www.xiaohongshu.com/search_result?keyword=a&type=1")).toBe(pageKey("https://www.xiaohongshu.com/search_result?type=1&keyword=a"));
  expect(pageKey("https://www.xiaohongshu.com/search_result?keyword=a")).not.toBe(pageKey("https://www.xiaohongshu.com/search_result?keyword=b"));
});

const NOTE = (index: number) => ({ text: `笔记 ${index}`, href: `https://www.xiaohongshu.com/user/profile/me/6512abcd0000000000${String(index).padStart(6, "0")}?xsec_token=x` });
const onXhs = (href: string) => { try { return /(^|\.)xiaohongshu\.com$/.test(new URL(href).hostname); } catch { return false; } };

test("only a read-only tab may be clicked: labels that change the account are refused before the browser opens", async () => {
  for (const label of ["关注", "取消收藏", "点赞", "删除", "发布笔记", "评论", "私信", "购买", "Follow", "Delete", "这个标签的文字实在是太长了不像一个标签"]) expect(clickProblem(label)).toBeDefined();
  for (const label of ["收藏", "专辑", "笔记", "赞过", "Posts", "Saved"]) expect(clickProblem(label)).toBeUndefined();
  const { read, opened } = reader(content);
  expect(await read("https://www.xiaohongshu.com/user/profile/me", { click: "取消收藏" })).toMatchObject({ ok: false, message: expect.stringContaining("不能点") });
  expect(await read("https://www.xiaohongshu.com/user/profile/me", { click: "关注" })).toMatchObject({ ok: false });
  expect(opened).toEqual([]);
});

test("the same page with a tab clicked is another page, each once; scrolling is capped at fifteen screens", async () => {
  const { read, calls } = reader((url, click) => click === "收藏" ? { url, title: "我的", text: "收藏 · 笔记 1", status: 200, links: [NOTE(1)] } : content(url));
  expect((await read("https://www.xiaohongshu.com/user/profile/me")).ok).toBe(true);
  expect(await read("https://www.xiaohongshu.com/user/profile/me", { click: "收藏", scrolls: 40 })).toMatchObject({ ok: true, items: 1, text: "收藏 · 笔记 1" });
  expect(await read("https://www.xiaohongshu.com/user/profile/me", { click: " 收藏 " })).toMatchObject({ ok: false, message: expect.stringContaining("已经读过") });
  expect(calls).toEqual([{ url: "https://www.xiaohongshu.com/user/profile/me", scrolls: 0 }, { url: "https://www.xiaohongshu.com/user/profile/me", scrolls: SITE_SCROLLS_MAX, click: "收藏" }]);
});

test("the reader counts the items a page lists: an empty favourites tab counts none, and every note link comes back", async () => {
  const many = Array.from({ length: 300 }, (_, index) => NOTE(index));
  const { read, site } = reader((url, click) => click === "收藏"
    ? { url, title: "我的", text: "你还没有收藏任何内容哦", status: 200, links: [{ text: "", href: "https://www.xiaohongshu.com/user/profile/me" }, { text: "发现", href: "https://www.xiaohongshu.com/explore" }] }
    : { url, title: "我的", text: many.map((note) => note.text).join("\n"), status: 200, links: [...many.map((note) => ({ ...note, text: "" })), { text: "外站", href: "https://evil.example/6512abcd000000000000aaaa" }] });
  expect(await read("https://www.xiaohongshu.com/user/profile/me", { click: "收藏" })).toMatchObject({ ok: true, items: 0, empty: true });
  expect(site.found()).toEqual({ items: 0, pages: [] });
  const notes = await read("https://www.xiaohongshu.com/user/profile/me?tab=note");
  // Note cards without text are kept: they are the items; the off-site link is not.
  expect(notes).toMatchObject({ ok: true, items: 300 });
  expect(notes.links).toHaveLength(300);
  expect(site.found()).toEqual({ items: 300, pages: [{ url: "https://www.xiaohongshu.com/user/profile/me?tab=note" }] });
  expect(itemLinks([NOTE(1), NOTE(1), { href: "https://www.xiaohongshu.com/notification" }, { href: "https://www.xiaohongshu.com/user/profile/me" }],
    "https://www.xiaohongshu.com/user/profile/me?tab=fav", onXhs)).toHaveLength(1);
});

function fakeDriver(screens: Array<{ url?: string; text: string; links?: Array<{ text: string; href: string }> }>, tabs: TabCandidate[] = []) {
  const log: string[] = [];
  let at = 0;
  const driver: PageDriver = {
    goto: async (url) => { log.push(`goto ${url}`); return 200; },
    pause: async () => {},
    wheel: async () => { log.push("wheel"); at = Math.min(at + 1, screens.length - 1); },
    snapshot: async () => { const screen = screens[at]!; return { url: screen.url ?? "https://www.xiaohongshu.com/user/profile/me?tab=fav", title: "我的", text: screen.text, links: screen.links ?? [] }; },
    tabs: async (label) => { log.push(`tabs ${label}`); return tabs; },
    clickTab: async (index) => { log.push(`click ${index}`); }
  };
  return { driver, log };
}

test("reading a page clicks the tab, not a button with the same words, and scrolls until two screens bring nothing new", async () => {
  const button: TabCandidate = { text: "收藏", tabLike: false, href: "", control: false };
  const tab: TabCandidate = { text: "收藏", tabLike: true, href: "", control: false };
  // A list that unloads what scrolled away: each screen shows only part of it.
  const { driver, log } = fakeDriver([
    { text: "我的\n笔记 1\n笔记 2", links: [NOTE(1), NOTE(2)] },
    { text: "我的\n笔记 3\n笔记 4", links: [NOTE(3), NOTE(4)] },
    { text: "我的\n笔记 4\n笔记 5", links: [NOTE(4), NOTE(5)] },
    { text: "我的\n笔记 4\n笔记 5", links: [NOTE(4), NOTE(5)] }
  ], [button, tab]);
  const page = await readPage(driver, "https://www.xiaohongshu.com/user/profile/me", { scrolls: SITE_SCROLLS_MAX, click: "收藏", onSite: onXhs });
  expect(log).toEqual(["goto https://www.xiaohongshu.com/user/profile/me", "tabs 收藏", "click 1", "wheel", "wheel", "wheel", "wheel"]);
  expect(page.click).toEqual({ label: "收藏", done: true });
  expect(page.text.split("\n")).toEqual(["我的", "笔记 1", "笔记 2", "笔记 3", "笔记 4", "笔记 5"]);
  expect(page.links.map((link) => link.text)).toEqual(["笔记 1", "笔记 2", "笔记 3", "笔记 4", "笔记 5"]);
  // A list that keeps what it loaded: each screen is the last one and more.
  const growing = fakeDriver([{ text: "a\nb" }, { text: "a\nb\nc" }, { text: "a\nb\nc" }, { text: "a\nb\nc" }]);
  expect((await readPage(growing.driver, "https://www.xiaohongshu.com/x", { scrolls: 2, onSite: onXhs })).text).toBe("a\nb\nc");
  expect(growing.log.filter((line) => line === "wheel")).toHaveLength(2);
});

test("a label that is only a button or a link off the site is not clicked, and ending up off the site stops the read", async () => {
  const only = fakeDriver([{ text: "笔记 1" }], [{ text: "收藏", tabLike: false, href: "", control: false }, { text: "收藏", tabLike: true, href: "https://evil.example/fav", control: false }]);
  const page = await readPage(only.driver, "https://www.xiaohongshu.com/user/profile/me", { scrolls: 0, click: "收藏", onSite: onXhs });
  expect(page.click).toMatchObject({ label: "收藏", done: false, why: expect.stringContaining("不是页面内的标签") });
  expect(only.log).not.toContain("click 0");
  expect(only.log).not.toContain("click 1");
  const left = fakeDriver([{ url: "https://evil.example/", text: "别处" }], [{ text: "专辑", tabLike: true, href: "", control: false }]);
  await expect(readPage(left.driver, "https://www.xiaohongshu.com/user/profile/me", { scrolls: 3, click: "专辑", onSite: onXhs })).rejects.toThrow("离开了这个网站");
});

