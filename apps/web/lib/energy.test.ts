import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({})), CodexSupervisorRequestError: class extends Error {} }));
import { DEFAULT_AVAILABILITY } from "@crossline/core";
import { HEALTH_SLEEP_SETTING, energyModel, issueHealthToken, slotEnergy, storeHealthSummary, workspaceForHealthToken } from "./energy";
import { nudgesFor } from "./nudges";
import { loadConversation } from "./conversation";
import { TEST_CTX } from "./test-support";
import { POST as healthPost } from "../app/api/health/sleep/route";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });
const ws = TEST_CTX.workspaceId;
const setup = () => { const store = globalThis.crosslineStore = new CrosslineStore(":memory:"); store.createPrincipalWithWorkspace("x", "y"); return store; };

test("a phone's night arrives in pieces and is kept as one episode, with only the day's heart-rate figures beside it", () => {
  const store = setup();
  expect(storeHealthSummary(ws, { sleep: [{ start: "2026-10-10T04:10:00Z", end: "2026-10-10T07:00:00Z" }, { start: "2026-10-10T07:20:00Z", end: "2026-10-10T12:05:00Z" },
    { start: "nonsense", end: "2026-10-10T12:05:00Z" }], hrvMs: 48.6, day: "2026-10-10" })).toEqual({ stored: 1 });
  expect(JSON.parse(store.getSetting(ws, HEALTH_SLEEP_SETTING)!)).toEqual([{ sleepAt: "2026-10-10T04:10:00.000Z", wakeAt: "2026-10-10T12:05:00.000Z", source: "ios-health" }]);
  expect(JSON.parse(store.getSetting(ws, "health.daily")!)).toEqual([{ day: "2026-10-10", hrvMs: 49 }]);
});

test("the shortcut's token is shown once and kept as a hash; a wrong one is refused, a new one cuts off the old", async () => {
  const store = setup();
  const { workspace } = store.createPrincipalWithWorkspace("phone-owner", "个人");
  const ctx = { ...TEST_CTX, workspaceId: workspace.id };
  const token = issueHealthToken(ctx);
  expect(store.getSetting(workspace.id, "health.token.sha256")).not.toContain(token);
  expect(workspaceForHealthToken(token)).toBe(workspace.id);
  const send = (bearer: string) => healthPost(new Request("http://127.0.0.1:3210/api/health/sleep", { method: "POST", headers: { authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ sleep: [{ start: "2026-10-10T04:10:00Z", end: "2026-10-10T12:05:00Z" }] }) }));
  expect((await send(token)).status).toBe(200);
  expect(JSON.parse(store.getSetting(workspace.id, HEALTH_SLEEP_SETTING)!)).toHaveLength(1);
  const replaced = issueHealthToken(ctx);
  expect((await send(token)).status).toBe(401);
  expect((await send(replaced)).status).toBe(200);
  expect((await send("x".repeat(30))).status).toBe(401);
});

test("a slot takes the model's level only when it is at least moderately sure; with no sleep known it keeps the pattern's", () => {
  setup();
  const model = energyModel(TEST_CTX, DEFAULT_AVAILABILITY);
  expect(model.predict("2026-10-10T15:00:00Z").confidence).toBe("low");
  expect(slotEnergy(model, "2026-10-10T15:00:00Z", "medium")).toBe("medium");
});

test("the energy question is asked when work starts within three hours, the model is unsure and no report is fresh — and not twice", async () => {
  vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-10-12T13:30:00.000Z"); // Monday 08:30 in Chicago
  const store = setup();
  store.saveWorkOrder({ id: "hw2", ownerId: TEST_CTX.principalId, workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "", intent: "完成 ECE 555 作业 2",
    state: "approved", riskTier: "routine", estimate: { p25Minutes: 30, p50Minutes: 45, p85Minutes: 60, source: "llm_prior", observationCount: 0, confidence: "low" },
    payload: { dueDate: "2026-10-14" } });
  const now = new Date("2026-10-12T13:30:00.000Z");
  const said = await nudgesFor(TEST_CTX, now);
  expect(said.map((item) => item.kind)).toContain("energy_check");
  const card = loadConversation(TEST_CTX, "2026-10-12").messages.find((message) => message.card?.nudgeKind === "energy_check")!.card!;
  expect(card.clarify.options.map((option) => option.label)).toEqual(["低", "中", "高", "少问这类"]);
  expect(card.actions.map((action) => action.action)).toEqual(["energy.report", "energy.report", "energy.report"]);
  expect((await nudgesFor(TEST_CTX, now)).map((item) => item.kind)).not.toContain("energy_check");
  // A fresh report: not asked in the next three hours.
  store.saveEnergyObservation({ id: "r1", ownerId: TEST_CTX.principalId, workspaceId: ws, source: "self_report", level: "high", confidence: "medium", aggregate: {},
    observedAt: "2026-10-12T14:00:00.000Z" });
  expect((await nudgesFor(TEST_CTX, new Date("2026-10-12T16:40:00.000Z"))).map((item) => item.kind)).not.toContain("energy_check");
});

test("with nights known and reports that agree, the model is sure enough for the schedule to use its level", () => {
  const store = setup();
  // Ten nights 23:00–07:00 read from the screen, and a report every morning at 10:00 saying high.
  const gaps = Array.from({ length: 10 }, (_, index) => {
    const date = new Date(Date.parse("2026-10-01T04:00:00Z") + index * 86_400_000);
    return { from: date.toISOString(), to: new Date(date.getTime() + 8 * 3_600_000).toISOString() };
  });
  store.setSetting(ws, "activity.longGaps", JSON.stringify(gaps));
  // Read only while 作息记录 is on.
  expect(energyModel(TEST_CTX, DEFAULT_AVAILABILITY).episodes).toEqual([]);
  store.setSetting(ws, "activity.sleepTracking", "granted");
  gaps.forEach((gap, index) => store.saveEnergyObservation({ id: `r${index}`, ownerId: TEST_CTX.principalId, workspaceId: ws, source: "self_report", level: "high",
    confidence: "medium", aggregate: {}, observedAt: new Date(Date.parse(gap.to) + 3 * 3_600_000).toISOString() }));
  const model = energyModel(TEST_CTX, DEFAULT_AVAILABILITY);
  expect(model.calibration.reports).toBe(10);
  const morning = new Date(Date.parse(gaps[9]!.to) + 3 * 3_600_000).toISOString();
  expect(model.predict(morning)).toMatchObject({ level: "high", confidence: "high" });
  expect(slotEnergy(model, morning, "low")).toBe("high");
});
