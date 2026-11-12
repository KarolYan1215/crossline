import { expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { ACTIVITY_RULES, TIME_DRAFT_DECISIONS, TIME_DRAFTS, type TimeDraft } from "@crossline/core";
import { ACTIVITY_DETAIL_CONSENT } from "./activity-recorder";
import { createTimeDraftPass, TIME_ATTRIBUTOR, unconfirmedWorkYesterday } from "./time-drafts";
import { fakeRuntime } from "./testing/fake-runtime";

/** 拟计时 in the worker (docs/plans/2026-11-11-walkthrough-decisions.md §1): drafted from the kept segments, the rest attributed by a model. */
const ws = "w";
const DAY = "2026-11-10";
const at = (clock: string, day = DAY) => `${day}T${clock}:00.000Z`;
const estimate = { p25Minutes: 40, p50Minutes: 60, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "high" as const };
const step = (id: string, role: string, title: string) => ({ id, role, title, deliverable: "d", doneCriterion: "c", share: 1, estimate: { p25Minutes: 30, p50Minutes: 45, p85Minutes: 60 },
  dependsOn: [], notBefore: "", dueBy: "", schedulable: true, executor: "human" as const, tickOutcome: "" });

function seed() {
  const store = new CrosslineStore(":memory:");
  store.setSetting(ws, "schedule.preferences", JSON.stringify({ timeZone: "UTC" }));
  store.setSetting(ws, ACTIVITY_DETAIL_CONSENT, "granted");
  const order = (id: string, intent: string, state: string) => store.saveWorkOrder({ id, ownerId: "o", workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "",
    intent, state, riskTier: "routine", estimate, payload: {} });
  order("hw", "完成 ECE 555 作业 3", "active");
  order("paper", "NeurIPS 论文初稿", "approved");
  order("old", "旧任务", "accepted");
  store.saveStepPlan(ws, "hw", { archetypeId: "problem_set", quantity: { basis: "题", amount: 1, unit: "题" }, rationale: "r", steps: [step("h1", "solve", "推导第 1 题")] }, "o", "initial");
  store.saveStepPlan(ws, "paper", { archetypeId: "paper", quantity: { basis: "篇", amount: 1, unit: "篇" }, rationale: "r", steps: [step("p1", "draft", "写引言")] }, "o", "initial");
  // The nudge pass saw the paper's block under way 09:00–10:00.
  store.setSetting(ws, `nudge.blocks:${DAY}`, JSON.stringify({ "scheduled:paper:v1s1": { id: "scheduled:paper:v1s1", orderId: "paper", stepId: "v1s1", title: "NeurIPS 论文初稿", step: "写引言",
    day: DAY, start: "09:00", end: "10:00", endedTimerAt: "", began: true } }));
  const stretch = (from: string, minutes: number, app: string, title: string, category: string) =>
    store.recordActivityReading({ workspaceId: ws, at: at(from), intervalSeconds: minutes * 60, app, title, category, idle: false });
  stretch("09:00", 40, "winword.exe", "intro.docx", "writing");
  stretch("14:00", 30, "code.exe", "ECE555 hw3.py", "coding");
  stretch("16:00", 20, "typora.exe", "blog.md", "writing");
  stretch("20:00", 25, "chrome.exe", "Overleaf – something", "writing");
  return store;
}
const drafts = (store: CrosslineStore) => JSON.parse(store.getSetting(ws, TIME_DRAFTS) ?? "[]") as TimeDraft[];

test("stretches are drafted by rule and block first; the model attributes the rest, only to open tasks, and is asked once", async () => {
  const store = seed();
  store.setSetting(ws, ACTIVITY_RULES, JSON.stringify([{ match: "typora", category: "writing", workOrderId: "paper", stepId: "v1s1" }]));
  let prompt = "";
  const answer = (prompts: string[]) => {
    prompt = prompts.at(-1) ?? "";
    const ids = [...prompt.matchAll(/draft:[0-9TZ:.-]+/g)].map((match) => match[0]);
    return JSON.stringify({ items: [
      { id: ids[0], workOrderId: "hw", stepId: "v1s1", why: "标题含 ECE555" },
      { id: ids.at(-1), workOrderId: "old", stepId: "", why: "" }] });
  };
  const runtime = fakeRuntime([answer], TIME_ATTRIBUTOR);
  expect(await createTimeDraftPass(store, ws, "C:\\repo", () => runtime.rpc)(new Date(at("23:00")))).toEqual({ drafted: 4, attributed: 1 });
  // The titles of the stretches nothing placed go to the model, with the open tasks; placed stretches and closed tasks do not.
  expect(prompt).toContain("ECE555 hw3.py");
  expect(prompt).toContain("Overleaf – something");
  expect(prompt).not.toContain("intro.docx");
  expect(prompt).not.toContain("旧任务");
  expect(drafts(store).map((draft) => [draft.start.slice(11, 16), draft.minutes, draft.basis, draft.workOrderId ?? "", draft.stepId ?? ""])).toEqual([
    ["09:00", 40, "block", "paper", "v1s1"], ["14:00", 30, "model", "hw", "v1s1"], ["16:00", 20, "rule", "paper", "v1s1"], ["20:00", 25, "none", "", ""]]);
  // Nothing of a title is kept in the drafts.
  expect(store.getSetting(ws, TIME_DRAFTS)).not.toMatch(/docx|hw3|Overleaf/);
  // The next pass drafts nothing again and does not ask the model about the stretch it could not place.
  expect(await createTimeDraftPass(store, ws, "C:\\repo", () => undefined)(new Date(at("23:30")))).toEqual({ drafted: 0, attributed: 0 });
  expect(drafts(store)).toHaveLength(4);
});

test("no consent, no drafts (and what there was is gone); a draft unconfirmed for 14 days is dropped; the brief counts yesterday's open ones", async () => {
  const store = seed();
  expect((await createTimeDraftPass(store, ws, "C:\\repo", () => undefined)(new Date(at("23:00")))).drafted).toBe(4);
  // Yesterday, seen from the next morning: four drafts, one decided.
  const [first] = drafts(store);
  store.setSetting(ws, TIME_DRAFT_DECISIONS, JSON.stringify({ [first!.id]: { decision: "not_work", at: at("23:10") } }));
  expect(unconfirmedWorkYesterday(store, ws, "2026-11-11", "UTC")).toBe(3);
  expect(unconfirmedWorkYesterday(store, ws, "2026-11-12", "UTC")).toBe(0);
  // Fifteen days later they are gone.
  await createTimeDraftPass(store, ws, "C:\\repo", () => undefined)(new Date(at("23:00", "2026-11-25")));
  expect(drafts(store)).toEqual([]);
  // Turned off: drafted again only after it is on, and the stored drafts are deleted at once.
  await createTimeDraftPass(store, ws, "C:\\repo", () => undefined)(new Date(at("23:00")));
  store.setSetting(ws, ACTIVITY_DETAIL_CONSENT, "denied");
  expect(await createTimeDraftPass(store, ws, "C:\\repo", () => undefined)(new Date(at("23:00")))).toEqual({ drafted: 0, attributed: 0 });
  expect(store.getSetting(ws, TIME_DRAFTS)).toBeUndefined();
});
