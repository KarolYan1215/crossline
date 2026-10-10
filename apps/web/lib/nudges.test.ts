import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({})), CodexSupervisorRequestError: class extends Error {} }));
import { decideCard, loadConversation } from "./conversation";
import { ANSWERED_SETTING, PRESENCE_SETTING, ensureOpener, nudgesFor } from "./nudges";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });

const ws = TEST_CTX.workspaceId;
// Monday 2026-10-12, 08:50 in Chicago: the default pattern's first hours start at 09:00.
const NOW = new Date("2026-10-12T13:50:00.000Z");
const estimate = { p25Minutes: 30, p50Minutes: 45, p85Minutes: 60, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };

function setup() {
  vi.stubEnv("CROSSLINE_FIXED_NOW", NOW.toISOString());
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.saveWorkOrder({ id: "hw2", ownerId: TEST_CTX.principalId, workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "", intent: "完成 ECE 555 作业 2",
    state: "approved", riskTier: "routine", estimate, payload: { dueDate: "2026-10-14" } });
  return store;
}
const nudges = () => loadConversation(TEST_CTX, "2026-10-12").messages.filter((message) => message.role === "nudge");

test("the day opens with its arrangements, its work and what is due soon, once", async () => {
  setup();
  expect(await ensureOpener(TEST_CTX, NOW)).toBe(true);
  expect(await ensureOpener(TEST_CTX, NOW)).toBe(false);
  const [opener] = nudges();
  expect(opener!.card!.clarify.question).toContain("三天内截止：完成 ECE 555 作业 2（10/14）");
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
