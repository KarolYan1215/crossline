import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import type { GrownSkillRecord } from "@crossline/core";
import { createSiteReader, judgePage, SITE_BREAKER_HOURS, SITE_PAGES_PER_RUN } from "./site-reader";
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
function reader(pages: (url: string) => Page, now = new Date("2026-10-15T15:00:00Z")) {
  const opened: string[] = [];
  const told: string[] = [];
  let closed = 0;
  const site = createSiteReader(store, ws, record, () => ({ dir: "C:\\p", browser: "chrome.exe" }), {
    now: () => now, sleep: async () => {}, notify: (text) => told.push(text),
    open: async () => ({ read: async (url) => { opened.push(url); return pages(url); }, close: async () => { closed += 1; } })
  });
  const read = async (url: string) => JSON.parse(await site.tools.call("site_read", { service: "小红书", url })) as { ok: boolean; message?: string; text?: string };
  return { site, read, opened, told, closed: () => closed };
}
const content = (url: string): Page => ({ url, title: "收藏", text: "笔记 A\n笔记 B", status: 200, links: [{ text: "笔记 A", href: "https://www.xiaohongshu.com/explore/1" }, { text: "外站", href: "https://evil.example/x" }] });

test("each page once, only the declared site, and a budget per run", async () => {
  const { read, opened } = reader(content);
  expect(await read("https://www.xiaohongshu.com/user/profile/me?tab=fav")).toMatchObject({ ok: true, text: "笔记 A\n笔记 B" });
  expect(await read("https://www.xiaohongshu.com/user/profile/me?tab=fav&x=1")).toMatchObject({ ok: false });
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
