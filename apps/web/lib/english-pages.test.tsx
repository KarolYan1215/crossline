import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { CrosslineStore, writeLocale } from "@crossline/db";

/**
 * An English account sees English (docs/i18n.md), end to end: the example board is seeded, the workspace's language is English, and the
 * six working pages are rendered as a signed-in request would render them — the request's language, the cookie the frame reads and the
 * page's client components all English. What may still be Chinese is only what a person or a model wrote: the seeded example board is
 * Chinese person content, so every string the ledger holds is collected and subtracted, and any Han text left is the system's own.
 */
vi.mock("server-only", () => ({}));
const EN_CTX = { principalId: "test-owner", workspaceId: "test-workspace", role: "owner" as const,
  identity: { provider: "credential" as const, issuer: "test", subject: "test-owner" },
  authMethod: "session" as const, requestId: "test-request", locale: "en" as const };
vi.mock("./access-guard", () => ({ requireSessionContext: async () => EN_CTX, resolveAccessContext: async () => ({ ctx: EN_CTX }) }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => name === "crossline-locale" ? { name, value: "en" } : undefined, getAll: () => [] }),
  headers: async () => new Headers()
}));
vi.mock("next/navigation", async (original) => ({ ...await original<typeof import("next/navigation")>(), useRouter: () => ({ refresh: () => {}, push: () => {} }),
  usePathname: () => "/", useSearchParams: () => new URLSearchParams() }));

const HAN = /[㐀-鿿豈-﫿]+/g;

beforeAll(async () => {
  vi.stubEnv("CROSSLINE_SEED_EXAMPLES", "1");
  vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-10-14T15:00:00.000Z");
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  writeLocale(globalThis.crosslineStore, EN_CTX.workspaceId, "en");
  const { ensureSeeded } = await import("./crossline");
  const { seedReadyToStart } = await import("./test-support");
  ensureSeeded(EN_CTX);
  seedReadyToStart(globalThis.crosslineStore, EN_CTX.workspaceId);
  // A few things that need the person, so the decisions read in English too: something waited for that is due today, a capture the
  // analysis stopped on, a milestone draft and a calendar that cannot be read.
  const store = globalThis.crosslineStore, ws = EN_CTX.workspaceId, owner = EN_CTX.principalId;
  store.saveWaitingItem({ id: "wait-data", ownerId: owner, workspaceId: ws, title: "实测数据", who: "师兄", expectedAt: "2026-10-14",
    approximate: true, followUpAt: "2026-10-14", state: "open", blocks: ["research-starter-work-order"], source: "manual" });
  store.capture({ id: "cap", ownerId: owner, workspaceId: ws, title: "整理组会意见", context: "组会上的三个质疑" }, "cap-1");
  store.transitionWorkOrder(ws, "cap", { type: "analysis.proposed", proposalId: "cap" }, "a1");
  store.transitionWorkOrder(ws, "cap", { type: "blocked", reason: "ANALYSIS_POLICY_BLOCKED" }, "a2",
    { audit: { blocker: { code: "ANALYSIS_POLICY_BLOCKED", message: "不清楚要交付什么" } } });
  store.saveMilestone({ id: "draft-1", ownerId: owner, workspaceId: ws, identityId: "research", projectId: "research-example", title: "投稿一篇会议论文",
    status: "draft", version: 1 });
  store.setSetting(ws, "calendar.sync.failure", JSON.stringify({ code: "GRAPH_SYNC_FAILED", message: "", at: "2026-10-14T14:00:00.000Z" }));
});
afterAll(() => { vi.unstubAllEnvs(); globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

/** Every string the ledger holds (the example board, settings, events): text a person or a model wrote, shown as it is. */
function writtenText(): string {
  const store = globalThis.crosslineStore!;
  const strings: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string") {
      strings.push(value);
      // Settings and payloads keep JSON inside strings.
      if (/^[[{]/.test(value)) { try { collect(JSON.parse(value)); } catch { /* plain text */ } }
    } else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect(store.exportSnapshot(EN_CTX.workspaceId));
  return strings.join("\n");
}

async function englishHtml(page: () => Promise<{ default: (props: never) => Promise<ReactElement> | ReactElement }>, props?: unknown): Promise<string> {
  const { LocaleProvider } = await import("../app/locale-context");
  const { default: Page } = await page();
  const element = await (Page as (props: unknown) => Promise<ReactElement>)(props);
  return renderToStaticMarkup(<LocaleProvider locale="en">{element}</LocaleProvider>);
}

/** The Han text a page shows that no person or model wrote, each with a little of what surrounds it. */
function systemChinese(html: string): string[] {
  const written = writtenText();
  const text = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "")
    // The language switch names Chinese in Chinese on purpose (an element marked lang="zh-CN", and the language card's 「中文」).
    .replace(/<[^>]*\blang="zh-CN"[^>]*>[^<]*/g, "").replace(/>中文</g, "><");
  return [...new Set([...text.matchAll(HAN)].filter((match) => !written.includes(match[0]))
    .map((match) => text.slice(Math.max(0, match.index! - 40), match.index! + match[0].length + 20).replace(/\s+/g, " ")))];
}

const noParams = { searchParams: Promise.resolve({}) };
const PAGES = [
  ["Today", () => import("../app/page"), undefined],
  ["Tasks", () => import("../app/workbench/page"), noParams],
  ["Decisions", () => import("../app/approvals/page"), noParams],
  ["Plan", () => import("../app/plan/page"), {}],
  ["Milestones", () => import("../app/milestones/page"), noParams],
  ["Settings", () => import("../app/settings/page"), undefined]
] as const;

test.each(PAGES)("%s shows no system Chinese to an English account", async (_name, page, props) => {
  const html = await englishHtml(page as never, props);
  expect(html.length).toBeGreaterThan(500);
  expect(systemChinese(html)).toEqual([]);
}, 60_000);

test("every decision the board raises is worded in English", async () => {
  const { collectAsks } = await import("./asks");
  const asks = collectAsks(EN_CTX, new Date("2026-10-14T15:00:00.000Z"));
  expect(asks.map((ask) => ask.kind)).toEqual(expect.arrayContaining(["waiting_due", "capture_blocked"]));
  const written = writtenText();
  const words = asks.flatMap((ask) => [ask.title, ask.why, ask.freeText?.placeholder ?? "", ask.preview?.label ?? "",
    ...ask.options.flatMap((option) => [option.label, option.detail ?? "", ...(option.fields ?? []).flatMap((field) => [field.label, field.placeholder ?? ""])])]);
  expect(words.flatMap((text) => (text.match(HAN) ?? []).filter((run) => !written.includes(run)).map((run) => `${run} in 「${text}」`))).toEqual([]);
  expect(asks.find((ask) => ask.kind === "waiting_due")!.title).toBe("Has \"实测数据\" from 师兄 arrived?");
});

test("the same pages still read in Chinese for a Chinese account (the default is untouched)", async () => {
  const { tFor } = await import("./i18n");
  expect(tFor("zh")("待决事项 {{count}} 项。", { count: 2 })).toBe("待决事项 2 项。");
  expect(tFor("en")("待决事项 {{count}} 项。", { count: 2 })).toBe("2 decisions.");
});
