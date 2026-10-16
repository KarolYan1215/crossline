import "@crossline/i18n/catalog/worker";
import { expect, test } from "vitest";
import { CrosslineStore, writeLocale } from "@crossline/db";
import { autoApproveEligible } from "./auto-approval";
import { statedConstraints } from "./diligence";
import { extractText } from "./extract";
import { notifyPass, planNotifications, type NotifyInput } from "./notify";
import { withChecklist } from "./onboarding-session";
import { safeGet } from "./safe-fetch";
import { isCheckNeeded, isLoginNeeded } from "./site-reader";

/**
 * What the worker writes for the person is in the workspace's language (docs/i18n.md): Chinese until the person switches, English from
 * then on. Nothing set reads exactly as before.
 */
const windows = [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "12:00", energy: "high" as const }];
const base: NotifyInput = { today: "2026-10-08", clock: "09:05", weekday: 4, level: "normal", windows, sent: new Set(), urgentSentToday: 0,
  pending: 4, waitingDue: [{ id: "wait-1", who: "Alex", title: "the measured data" }],
  dueSoon: [{ id: "m1", title: "Paper draft", deadline: "2026-10-09", daysLeft: 1 }], gateRefusals: [] };

test("the morning brief and the urgent messages are written in the workspace's language", () => {
  const chinese = planNotifications(base);
  expect(chinese[0]).toMatchObject({ title: "今天的 Crossline" });
  expect(chinese[0]!.body).toBe("今天该到：Alex的the measured data；1 天后到期：Paper draft；4 项待决定");
  const english = planNotifications({ ...base, locale: "en" });
  expect(english[0]).toMatchObject({ kind: "brief", title: "Crossline today" });
  expect(english[0]!.body).toBe("Due to arrive today: the measured data from Alex; Due in 1 day: Paper draft; 4 decisions waiting");
  expect(english.filter((item) => item.kind === "urgent").map((item) => [item.title, item.body])).toEqual([
    ["Has the measured data from Alex arrived?", "Once it arrives, press \"It has arrived\" so the work that depends on it can go on the calendar."],
    ["Due tomorrow: Paper draft", "Due Oct 9."]]);
});

test("a pass for an English workspace sends English to the desktop and the phone", async () => {
  const store = new CrosslineStore(":memory:");
  writeLocale(store, "w", "en");
  store.setSetting("w", "schedule.availability", JSON.stringify(windows));
  const shown: string[] = [];
  const pushed: Array<{ title: string; body: string }> = [];
  await notifyPass(store, "w", new Date("2026-10-08T14:10:00Z"), async (title) => { shown.push(title); return true; }, undefined,
    async (_workspace, message) => { pushed.push(message); return true; });
  expect(shown).toEqual(["Crossline today"]);
  expect(pushed[0]).toMatchObject({ title: "Crossline today", body: "Nothing due today." });
  store.close();
});

test("work that takes effect by itself is announced in the workspace's language", () => {
  const estimate = { p25Minutes: 30, p50Minutes: 45, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };
  const store = new CrosslineStore(":memory:");
  writeLocale(store, "w", "en");
  store.saveWorkOrder({ id: "prep", ownerId: "o", workspaceId: "w", identityId: "research", projectId: "p", milestoneId: "", intent: "Organize review notes",
    state: "awaiting_plan_approval", riskTier: "routine", estimate, payload: { family: "preparation", humanCore: [] } });
  expect(autoApproveEligible(store, "w")).toEqual(["prep"]);
  const card = store.listRecentNudges("w", "2000-01-01T00:00:00.000Z")[0]!.payload.card as { clarify: { question: string; options: Array<{ label: string }> } };
  expect(card.clarify.question).toBe("1 task took effect by itself and is on the schedule: \"Organize review notes\". None of them needs your choice, permission or an outside action; undo any within 24 hours under \"Recently took effect\" on the Decisions page.");
  expect(card.clarify.options.map((option) => option.label)).toEqual(["Take a look", "Got it"]);
  store.close();
});

test("a file that cannot be read says why in the reader's language", async () => {
  expect((await extractText(new Uint8Array(4), "image")).note).toBe("图片没有文字层；需要以图片形式交给模型查看。");
  expect((await extractText(new Uint8Array(4), "image", "en")).note).toBe("An image has no text layer; it has to be given to the model as an image.");
});

test("a page that refuses to open says so in the reader's language, and gives its status to the code that reads it", async () => {
  const deps = { fetchImpl: (async () => new Response("no", { status: 403 })) as typeof fetch, isPublicHost: async () => true };
  expect(await safeGet("https://example.edu/x", deps, { maxBytes: 1000 })).toEqual({ ok: false, reason: "返回 403", status: 403 });
  expect(await safeGet("https://example.edu/x", deps, { maxBytes: 1000, locale: "en" })).toEqual({ ok: false, reason: "returned 403", status: 403 });
});

test("the interview's own closing line follows the interview's language", () => {
  const turn = { nextAction: "ready_for_milestones", reply: "OK.", questions: [] } as unknown as Parameters<typeof withChecklist>[0];
  const open = [{ label: "Weekly hours", detail: "", owner: "interview" as const }];
  expect(withChecklist(turn, open).reply).toBe("OK.\n\n完成访谈前还缺：Weekly hours。");
  const english = withChecklist(turn, open, "en");
  expect(english.reply).toBe("OK.\n\nStill missing before the interview is complete: Weekly hours.");
  expect(english.questions[0]!.text).toBe("Still missing before the interview is complete: Weekly hours. Please add it.");
});

test("what the run reports back is recognised in either language (heuristics read what the model wrote)", () => {
  expect(isLoginNeeded("需要登录：小红书")).toBe(true);
  expect(isLoginNeeded("Login needed: Xiaohongshu")).toBe(true);
  expect(isCheckNeeded("需要本人完成小红书安全验证")).toBe(true);
  expect(isCheckNeeded("Security check needed: complete it on Xiaohongshu")).toBe(true);
  expect(isLoginNeeded("整理收藏")).toBe(false);
});

test("constraints the person stated are found in Chinese and in English", () => {
  const facts = [{ slot: "budget", value: "不能花钱买课" }, { slot: "time", value: "I can't work on weekends" }, { slot: "note", value: "Likes mornings" },
    { slot: "hard_limit", value: "20 hours a week" }];
  expect(statedConstraints(facts)).toEqual(["不能花钱买课", "I can't work on weekends", "20 hours a week"]);
});
