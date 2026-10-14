import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({})), CodexSupervisorRequestError: class extends Error {} }));
import { DEFAULT_AVAILABILITY } from "@crossline/core";
import { HEALTH_SLEEP_SETTING, energyModel, issueHealthToken, slotEnergy, storeHealthSummary, workspaceForHealthToken } from "./energy";
import { nudgesFor } from "./nudges";
import { ENERGY_VOI_SETTING } from "./crossline";
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

test("the energy question is asked when work starts within three hours, the model is unsure, no report is fresh and the answer would change the next three hours — and not twice", async () => {
  vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-10-12T13:30:00.000Z"); // Monday 08:30 in Chicago
  const store = setup();
  const order = (id: string, intent: string, energy: "low" | "high", dueDate?: string) => store.saveWorkOrder({ id, ownerId: TEST_CTX.principalId, workspaceId: ws,
    identityId: "research", projectId: "p", milestoneId: "", intent, state: "approved", riskTier: "routine",
    estimate: { p25Minutes: 30, p50Minutes: 45, p85Minutes: 60, source: "llm_prior", observationCount: 0, confidence: "low" },
    payload: { ...(dueDate ? { dueDate } : {}), humanCore: [{ energy }] } });
  // Light work alone: any hour suits it, 「低」 and 「高」 give the same next three hours, so the question would change nothing and is not asked.
  order("tidy", "整理文献笔记", "low", "2026-10-13");
  const now = new Date("2026-10-12T13:30:00.000Z");
  expect((await nudgesFor(TEST_CTX, now)).map((item) => item.kind)).not.toContain("energy_check");
  expect(JSON.parse(store.getSetting(ws, ENERGY_VOI_SETTING)!)).toMatchObject({ differs: false });
  // A homework that needs a high hour beside it: now the answer decides which of the two the morning goes to.
  order("hw2", "完成 ECE 555 作业 2", "high", "2026-10-14");
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

test("the phone's bed and wake moments become a night; the day's other readings are kept within range and merged per day", () => {
  const store = setup();
  storeHealthSummary(ws, { events: [{ type: "bed", at: "2026-10-10T04:30:00Z" }, { type: "wake", at: "2026-10-10T12:10:00Z" }, { type: "nap", at: "2026-10-10T13:00:00Z" }] });
  storeHealthSummary(ws, { day: "2026-10-10", restingHr: 58, wristTempDeltaC: 0.62, steps: -5, daylightMin: 95 });
  storeHealthSummary(ws, { day: "2026-10-10", hrvMs: 51, source: "android-health" });
  expect(JSON.parse(store.getSetting(ws, "health.daily")!)).toEqual([{ day: "2026-10-10", restingHr: 58, wristTempDeltaC: 0.62, daylightMin: 95, hrvMs: 51 }]);
  const model = energyModel(TEST_CTX, DEFAULT_AVAILABILITY);
  expect(model.episodes).toEqual([{ sleepAt: "2026-10-10T04:30:00.000Z", wakeAt: "2026-10-10T12:10:00.000Z", source: "phone-focus" }]);
  expect(model.capacity("2026-10-10T15:00:00Z", "2026-10-10").multiplier).toBe(0.9);
});

test("Siri's capture token writes a line and nothing else; a health token cannot write one, and thirty an hour is the limit", async () => {
  const store = setup();
  const { workspace } = store.createPrincipalWithWorkspace("phone-owner", "个人");
  const ctx = { ...TEST_CTX, workspaceId: workspace.id };
  const { POST: capturePost } = await import("../app/api/capture/shortcut/route");
  const { issueDeviceToken } = await import("./energy");
  const capture = issueDeviceToken(ctx, "capture"), health = issueDeviceToken(ctx, "health");
  const send = (bearer: string, text = "周五前把报销单交了") => capturePost(new Request("http://127.0.0.1:3210/api/capture/shortcut",
    { method: "POST", headers: { authorization: `Bearer ${bearer}` }, body: JSON.stringify({ text }) }));
  expect((await send(health)).status).toBe(401);
  expect((await send(capture)).status).toBe(200);
  expect(store.listCaptures(workspace.id).map((item) => item.title)).toEqual(["周五前把报销单交了"]);
  expect((await send(capture, "x".repeat(241))).status).toBe(400);
  for (let i = 0; i < 29; i += 1) await send(capture, `第 ${i} 条`);
  expect((await send(capture)).status).toBe(429);
});

test("an optional signal moves a reading only after it earns it: off by consent, recorded while unproven, applied once the backtest admits it", () => {
  const store = setup();
  const nights = Array.from({ length: 14 }, (_, index) => {
    const wake = Date.parse("2026-10-01T12:00:00Z") + index * 86_400_000;
    return { start: new Date(wake - 8 * 3_600_000).toISOString(), end: new Date(wake).toISOString() };
  });
  storeHealthSummary(ws, { sleep: nights });
  // Twenty-eight afternoon reports (16:00 and 17:00 local, where the sleep model alone reads medium) whose level follows how broken up
  // the input was in the hour before.
  const buckets: Array<{ start: string; minutes: number; activeSec: number; pauses: number; mousePx: number }> = [];
  for (let index = 0; index < 28; index += 1) {
    const day = Math.floor(index / 2), observedAt = new Date(Date.parse("2026-10-01T21:00:00Z") + day * 86_400_000 + (index % 2) * 3_600_000).toISOString();
    const level = (["low", "medium", "high"] as const)[index % 3]!;
    const pauses = level === "low" ? 60 : level === "medium" ? 20 : 2;
    for (let q = 1; q <= 4; q += 1) buckets.push({ start: new Date(Date.parse(observedAt) - q * 15 * 60_000).toISOString(), minutes: 15, activeSec: 600, pauses, mousePx: 5000 });
    store.saveEnergyObservation({ id: `r${index}`, ownerId: "x", workspaceId: ws, source: "self_report", level, confidence: "high", aggregate: { responseSeconds: 2 }, observedAt });
  }
  store.setSetting(ws, "activity.inputRhythm.buckets", JSON.stringify(buckets));
  expect(energyModel(TEST_CTX, DEFAULT_AVAILABILITY).covariates).toEqual([]);
  store.setSetting(ws, "activity.inputRhythm", "granted");
  const model = energyModel(TEST_CTX, DEFAULT_AVAILABILITY);
  const fragmentation = model.covariates.find((item) => item.id === "input.fragmentation")!;
  expect(fragmentation.enabled).toBe(true);
  expect(fragmentation.hitsWith).toBeGreaterThan(fragmentation.hitsWithout);
  const last = "2026-10-14T22:00:00.000Z";
  expect(model.predict(last).basis.join(" ")).toContain("按键鼠停顿");
});
