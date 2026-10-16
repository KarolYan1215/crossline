import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({})), CodexSupervisorRequestError: class extends Error {} }));
import { decideCard, loadConversation } from "./conversation";
import { ANSWERED_SETTING, PRESENCE_SETTING, ensureOpener, nudgesFor } from "./nudges";
import { TEST_CTX, seedReadyToStart } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });

const ws = TEST_CTX.workspaceId;
// Monday 2026-10-12, 08:50 in Chicago: the default pattern's first hours start at 09:00.
const NOW = new Date("2026-10-12T13:50:00.000Z");
const estimate = { p25Minutes: 30, p50Minutes: 45, p85Minutes: 60, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };

function setup() {
  vi.stubEnv("CROSSLINE_FIXED_NOW", NOW.toISOString());
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  seedReadyToStart(store, ws);
  store.saveWorkOrder({ id: "hw2", ownerId: TEST_CTX.principalId, workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "", intent: "完成 ECE 555 作业 2",
    state: "approved", riskTier: "routine", estimate, payload: { dueDate: "2026-10-14" } });
  return store;
}
const nudges = () => loadConversation(TEST_CTX, "2026-10-12").messages.filter((message) => message.role === "nudge");

test("no day summary is written before the start standard holds: it would describe an empty plan all day", async () => {
  vi.stubEnv("CROSSLINE_FIXED_NOW", NOW.toISOString());
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  expect(await ensureOpener(TEST_CTX, NOW)).toBe(false);
});

test("the day opens with its arrangements, its work and what is due soon, once", async () => {
  setup();
  expect(await ensureOpener(TEST_CTX, NOW)).toBe(true);
  expect(await ensureOpener(TEST_CTX, NOW)).toBe(false);
  const [opener] = nudges();
  expect(opener!.card!.clarify.question).toContain("三天内截止：完成 ECE 555 作业 2（10/14）");
  expect(opener!.card!.clarify.question.startsWith("10 月 12 日 周一。")).toBe(true);
  // The text version is a few short lines (two of each, names cut short), never one run-on paragraph.
  expect(opener!.card!.clarify.question.split("\n").every((line) => line.length <= 80)).toBe(true);
  expect(opener!.card!.clarify.options.map((option) => option.label)).toContain("打开计划");
});

test("ten minutes before the scheduler's block for work due in two days, it says so once, with buttons that are the answer", async () => {
  const store = setup();
  const said = await nudgesFor(TEST_CTX, NOW);
  expect(said.map((item) => item.kind)).toContain("block_start");
  expect(await nudgesFor(TEST_CTX, NOW)).toEqual([]);
  const message = nudges().find((item) => item.card?.nudgeKind === "block_start")!;
  expect(message.card!.clarify.question).toContain("关系到 10/14 的截止");
  // No page has been seen: it waits for the worker to send it.
  expect(store.getConversationMessage(ws, message.id)!.payload.nudge).toMatchObject({ delivery: "pending" });
  // 「少问这类」 is the answer, and the kind is quiet for a week.
  const mute = message.card!.clarify.options.findIndex((option) => option.kind === "mute");
  expect(await decideCard(TEST_CTX, message.id, { option: mute }, NOW)).toMatchObject({ ok: true });
  expect(store.getSetting(ws, "nudge.mute.block_start")).toBe("2026-10-19");
});

test("with a page in front of the person it is shown there; while they just answered something, only the urgent get through", async () => {
  const store = setup();
  store.setSetting(ws, PRESENCE_SETTING, NOW.toISOString());
  store.setSetting(ws, ANSWERED_SETTING, NOW.toISOString());
  const said = await nudgesFor(TEST_CTX, NOW);
  expect(said.every((item) => item.urgent)).toBe(true);
  expect(store.getConversationMessage(ws, nudges()[0]!.id)!.payload.nudge).toMatchObject({ delivery: "page" });
});

test("the opener also stores the day as data, which the conversation hands to the card; its text stays for the phone", async () => {
  setup();
  await ensureOpener(TEST_CTX, NOW);
  const [opener] = nudges();
  expect(opener!.opener).toMatchObject({ day: "2026-10-12", label: "10 月 12 日 周一", timeZone: expect.any(String),
    soon: [{ title: "完成 ECE 555 作业 2", due: "2026-10-14", line: "research" }], asks: { count: expect.any(Number) } });
  expect(Array.isArray(opener!.opener!.work) && Array.isArray(opener!.opener!.fixed)).toBe(true);
  expect(opener!.card!.clarify.question.startsWith("10 月 12 日 周一。")).toBe(true);
});

test("a new proposal is announced once its steps are planned, not while it is still being prepared", async () => {
  const store = setup();
  store.saveWorkOrder({ id: "prop", ownerId: TEST_CTX.principalId, workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "", intent: "选定首轮选题",
    state: "awaiting_plan_approval", riskTier: "routine", estimate, payload: {} });
  store.appendEvent({ ownerId: TEST_CTX.principalId, workspaceId: ws, idempotencyKey: "prop:proposed", type: "work_order.transitioned", entityId: "prop",
    payload: { from: "analyzing", to: "awaiting_plan_approval" } });
  const announced = () => nudges().some((message) => message.card?.clarify.question.includes("「选定首轮选题」已分析好"));
  await nudgesFor(TEST_CTX, NOW);
  expect(announced()).toBe(false);
  store.saveStepPlan(ws, "prop", { archetypeId: "problem_set", quantity: { basis: "选题数", amount: 4, unit: "个" }, rationale: "",
    steps: [{ id: "s", role: "solve", title: "列出候选选题", deliverable: "候选清单", doneCriterion: "四类各一", share: 1, estimate: { p25Minutes: 20, p50Minutes: 30, p85Minutes: 50 },
      dependsOn: [], notBefore: "", dueBy: "", schedulable: true, executor: "human", tickOutcome: "" }] }, TEST_CTX.principalId, "planned");
  await nudgesFor(TEST_CTX, NOW);
  expect(announced()).toBe(true);
});
