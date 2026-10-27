import { afterEach, expect, test } from "vitest";
import { normalizeStepPlan, type CostSignal, type StepPlan } from "@crossline/core";
import { CrosslineStore, needStatesOf, openNeedsOf, provisionsOf } from "@crossline/db";
import { MATERIAL_RESEARCHER_SKILL } from "./manualbook";
import { createNeedChecker, needsAwaitingCheck } from "./need-check";
import { scriptedRuntime } from "./testing/fake-runtime";

/** Files first, then the web, then the person (2026-10-22): a need the web covers is never asked. */
let store: CrosslineStore;
afterEach(() => store?.close());
const ws = "w";
const healthy: CostSignal = { available: true, limitReached: false, short: { usedPercent: 10, windowDurationMins: 300, resetsAt: null }, long: { usedPercent: 10, windowDurationMins: 10080, resetsAt: null } };
const estimate = { p25Minutes: 30, p50Minutes: 45, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };
const step = (id: string, title: string, extra: Partial<StepPlan["steps"][number]> = {}) => ({ id, role: "practice" as const, title, deliverable: "", doneCriterion: "x", share: 1,
  estimate: { p25Minutes: 20, p50Minutes: 60, p85Minutes: 90 }, dependsOn: [], notBefore: "", dueBy: "", schedulable: true, executor: "human" as const,
  tickOutcome: "", covers: [] as string[], why: "", product: "ability" as const, ...extra });
const seed = () => {
  store = new CrosslineStore(":memory:");
  store.saveWorkOrder({ id: "t", ownerId: "o", workspaceId: ws, identityId: "research", projectId: "ece548", milestoneId: "m", intent: "期中复习",
    state: "approved", riskTier: "routine", estimate, payload: { title: "ECE 548 期中复习" } });
  const raw: StepPlan = { archetypeId: "exam_prep", quantity: { basis: "", amount: 0, unit: "" }, rationale: "", units: [], questions: [],
    needs: [{ id: "n1", what: "往年期中卷", why: "限时模拟要用", basis: "课程大纲写往年卷在 Canvas", kind: "reference" },
      { id: "n2", what: "该次运行的链接", why: "定位失败", basis: "通知邮件里有链接", kind: "personal" }], steps: [step("a", "限时模拟", { uses: ["n1", "n2"] })] };
  store.saveStepPlan(ws, "t", normalizeStepPlan(raw).plan, "o", "planned");
};
const fetchImpl = (async (input: string | URL | Request) => String(input) === "https://ocw.example.edu/exams"
  ? new Response("<html><head><title>Past Midterms</title></head><body>exams</body></html>", { status: 200, headers: { "content-type": "text/html" } })
  : new Response("", { status: 404 })) as typeof fetch;
const deps = { readCost: async () => healthy, webBlocker: () => undefined, now: () => new Date("2026-10-22T12:00:00.000Z"),
  safeGet: { fetchImpl, isPublicHost: async () => true } };
const answer = (sources: unknown[]) => () => JSON.stringify({ sources, gaps: [], blockers: [] });

test("a need a public page made for the task covers is settled without asking", async () => {
  seed();
  // The person's own link is never looked for on the web: asked at once.
  expect(needsAwaitingCheck(store, ws)).toMatchObject([{ workOrderId: "t", needId: "n1" }]);
  expect(needStatesOf(store, ws, "t").get("n2")).toBe("ask");
  const { rpc } = scriptedRuntime([MATERIAL_RESEARCHER_SKILL], answer([{ id: "s1", url: "https://ocw.example.edu/exams", title: "Past Midterms", publisher: "OCW",
    kind: "tutorial", openAccess: "unknown", licenseNote: "", summary: "历年期中卷" }]));
  expect(await createNeedChecker(store, ws, ".", () => rpc, deps)(needsAwaitingCheck(store, ws)[0]!)).toBe("public");
  expect([...provisionsOf(store, ws, "t")]).toEqual([["n1", "public"]]);
  const plan = store.getStepPlan(ws, "t")!;
  expect(openNeedsOf(plan, plan.steps.find((item) => item.title === "限时模拟")!)).toEqual(["n2"]);
  expect(needsAwaitingCheck(store, ws)).toEqual([]);
});

test("nothing found on the web: the person is asked", async () => {
  seed();
  // General pages with a gap named are not the material.
  const { rpc } = scriptedRuntime([MATERIAL_RESEARCHER_SKILL], () => JSON.stringify({ sources: [{ id: "s1", url: "https://ocw.example.edu/exams", title: "Past Midterms",
    publisher: "OCW", kind: "tutorial", openAccess: "unknown", licenseNote: "", summary: "别的学校的卷子" }], gaps: ["没有这门课自己的往年卷"], blockers: [] }));
  expect(await createNeedChecker(store, ws, ".", () => rpc, deps)(needsAwaitingCheck(store, ws)[0]!)).toBe("ask");
  expect([...needStatesOf(store, ws, "t")]).toEqual([["n1", "ask"], ["n2", "ask"]]);
  expect(needsAwaitingCheck(store, ws)).toEqual([]);
});
