import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { ACTIVITY_RULES, TIME_DRAFTS } from "@crossline/core";
vi.mock("server-only", () => ({}));
import { ACTIVITY_DETAIL_CONSENT, LOCAL_ACTIVITY_CONSENT, toZonedInstant } from "./crossline";
import { answerDraft, answerDraftConsent, draftConsent } from "./time-drafts";
import { loadWrap } from "./wrap";
import { TEST_CTX } from "./test-support";

/** 拟计时 on the wrap-up (docs/plans/2026-11-11-walkthrough-decisions.md §1): the person confirms drafted time; only then is it measured. */
afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });

const ws = TEST_CTX.workspaceId;
const ZONE = "America/Chicago";
const DAY = "2026-11-10";
const iso = (clock: string) => toZonedInstant(DAY, clock, ZONE);
const estimate = { p25Minutes: 40, p50Minutes: 60, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "high" as const };
const draft = (id: string, from: string, to: string, minutes: number, over: Record<string, unknown> = {}) =>
  ({ id, start: iso(from), end: iso(to), minutes, app: "winword.exe", category: "writing", basis: "none", createdAt: iso("22:00"), ...over });

function seed() {
  vi.stubEnv("CROSSLINE_FIXED_NOW", iso("22:30"));
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const order = (id: string, intent: string, state: string) => store.saveWorkOrder({ id, ownerId: TEST_CTX.principalId, workspaceId: ws, identityId: "research",
    projectId: "p", milestoneId: "", intent, state, riskTier: "routine", estimate, payload: {} });
  order("hw", "完成 ECE 555 作业 3", "active");
  order("paper", "NeurIPS 论文初稿", "approved");
  order("old", "旧任务", "accepted");
  store.setSetting(ws, `nudge.blocks:${DAY}`, JSON.stringify({ "scheduled:hw:1": { id: "scheduled:hw:1", orderId: "hw", stepId: "", title: "完成 ECE 555 作业 3", step: "",
    day: DAY, start: "09:00", end: "10:00", endedTimerAt: "", began: true } }));
  store.setSetting(ws, ACTIVITY_DETAIL_CONSENT, "granted");
  store.setSetting(ws, TIME_DRAFTS, JSON.stringify([
    draft("d1", "09:05", "09:50", 40, { workOrderId: "hw", basis: "block" }),
    draft("d2", "14:00", "14:30", 30, { workOrderId: "paper", basis: "model", why: "Overleaf 项目名" }),
    draft("d3", "16:00", "16:20", 20, { app: "typora.exe" }),
    draft("d4", "20:00", "20:25", 25)]));
  return store;
}

test("the wrap-up offers a block's own drafts as one 「按拟计时记」 and the rest as 「这些时间在做什么？」; only a confirmed draft is measured time", () => {
  const store = seed();
  const view = loadWrap(TEST_CTX, undefined, DAY);
  expect(view.draftConsent).toBe("on");
  expect(view.rows[0]!.draft).toEqual({ ids: ["d1"], minutes: 40 });
  expect(view.drafts.map((item) => [item.id, item.workOrderId ?? "", item.title ?? ""])).toEqual([["d2", "paper", "NeurIPS 论文初稿"], ["d3", "", ""], ["d4", "", ""]]);
  expect(view.tasks.map((task) => task.id).sort()).toEqual(["hw", "paper"]);
  expect(store.listExecutions(ws)).toEqual([]);

  // 按拟计时记 40 分: an observed session over the drafted stretch, marked as a confirmed draft.
  expect(answerDraft(TEST_CTX, "d1", { action: "confirm" })).toEqual({ ok: true, minutes: 40 });
  expect(store.listExecutions(ws, "hw")).toEqual([expect.objectContaining({ startedAt: iso("09:05"), endedAt: iso("09:50"), durationObserved: true, source: "inferred_confirmed" })]);
  // A task picked instead of the proposed one; a closed task is refused.
  expect(answerDraft(TEST_CTX, "d2", { action: "confirm", workOrderId: "old" })).toEqual({ ok: false, code: "DRAFT_TASK_INVALID" });
  expect(answerDraft(TEST_CTX, "d2", { action: "confirm", workOrderId: "hw" })).toMatchObject({ ok: true });
  // 以后这类都算 X: recorded on X and a rule for the app.
  expect(answerDraft(TEST_CTX, "d3", { action: "rule", workOrderId: "paper" })).toMatchObject({ ok: true });
  expect(JSON.parse(store.getSetting(ws, ACTIVITY_RULES)!)).toEqual([{ match: "typora.exe", category: "writing", workOrderId: "paper" }]);
  expect(store.listExecutions(ws, "paper")).toHaveLength(1);
  // 不算工作: nothing measured.
  expect(answerDraft(TEST_CTX, "d4", { action: "not_work" })).toEqual({ ok: true });
  expect(store.listExecutions(ws)).toHaveLength(3);
  // Each once.
  expect(answerDraft(TEST_CTX, "d4", { action: "not_work" })).toEqual({ ok: false, code: "DRAFT_NOT_FOUND" });
  const after = loadWrap(TEST_CTX, undefined, DAY);
  expect(after.rows[0]!.draft).toBeUndefined();
  expect(after.drafts).toEqual([]);
});

test("with 「应用与窗口」 off the wrap-up asks once; no turns it off and is not asked again, yes turns it on", () => {
  const store = seed();
  store.setSetting(ws, ACTIVITY_DETAIL_CONSENT, "denied");
  store.setSetting(ws, LOCAL_ACTIVITY_CONSENT, "granted");
  const view = loadWrap(TEST_CTX, undefined, DAY);
  expect(view.draftConsent).toBe("ask");
  // Without the consent no draft is offered, even one the worker left.
  expect(view.rows[0]!.draft).toBeUndefined();
  expect(view.drafts).toEqual([]);
  expect(answerDraftConsent(TEST_CTX, false)).toEqual({ ok: true });
  expect(store.getSetting(ws, ACTIVITY_DETAIL_CONSENT)).toBe("denied");
  expect(store.getSetting(ws, LOCAL_ACTIVITY_CONSENT)).toBe("granted");
  expect(draftConsent(TEST_CTX)).toBe("off");

  store.setSetting(ws, "activity.drafts.asked", "");
  expect(draftConsent(TEST_CTX)).toBe("ask");
  expect(answerDraftConsent(TEST_CTX, true)).toEqual({ ok: true });
  expect(store.getSetting(ws, ACTIVITY_DETAIL_CONSENT)).toBe("granted");
  expect(draftConsent(TEST_CTX)).toBe("on");
});
