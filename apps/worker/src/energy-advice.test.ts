import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { ENERGY_ADVICE_SETTING, readEnergyAdvice } from "@crossline/core";
import { ENERGY_ADVISOR, computeEnergyAdvice, energyAdviceDue, energyAdvicePass } from "./energy-advice";
import { fakeRuntime } from "./testing/fake-runtime";

let store: CrosslineStore;
let workspaceId: string;
const NOW = new Date("2026-10-15T15:00:00.000Z");

beforeEach(() => {
  store = new CrosslineStore(":memory:");
  workspaceId = store.createPrincipalWithWorkspace("u", "w").workspace.id;
});
afterEach(() => store.close());

const report = (at: string, level: "low" | "medium" | "high") => store.saveEnergyObservation({ id: `r-${at}`, workspaceId, ownerId: "u", source: "self_report", level,
  confidence: "high", observedAt: at, aggregate: {} });
const page = (title: string) => new Response(`<html><head><title>${title}</title></head><body>${title}</body></html>`, { status: 200, headers: { "content-type": "text/html" } });
const deps = (pages: Record<string, () => Response>) => ({ fetchImpl: (async (input: string | URL | Request) => {
  const handler = pages[String(input)];
  if (!handler) throw new Error("unreachable");
  return handler();
}) as typeof fetch, isPublicHost: async () => true });

const review = JSON.stringify({ verdict: "adjust", summary: "午后低谷有一致证据，13–14 时下调一级。",
  findings: [{ claim: "午饭后一至两小时警觉度下降", sourceIds: ["s1"] }, { claim: "无法核实的说法", sourceIds: ["s2"] }],
  adjustments: [{ days: "all", start: "13:00", end: "14:00", level: "low", why: "午后低谷", sourceIds: ["s1"] },
    { days: "all", start: "10:00", end: "11:00", level: "high", why: "来源打不开", sourceIds: ["s2"] }],
  sources: [{ id: "s1", url: "https://example.edu/post-lunch-dip", title: "The post-lunch dip in alertness" },
    { id: "s2", url: "https://made-up.example.org/x", title: "Invented page" }] });

test("without enough record it stores what is missing, and is not due again for a week", async () => {
  const advice = await computeEnergyAdvice(store, workspaceId, "C:\\repo", { review: false, now: NOW });
  expect(advice).toMatchObject({ insufficient: expect.stringContaining("自评") });
  expect(energyAdviceDue(store, workspaceId, new Date(NOW.getTime() + 86_400_000))).toBe(false);
  expect(energyAdviceDue(store, workspaceId, new Date(NOW.getTime() + 8 * 86_400_000))).toBe(true);
});

test("the review moves a band only on a source that opened; a claim on a dead page is dropped", async () => {
  // 16:30 and 17:00 in Chicago, both high.
  report("2026-10-07T21:30:00.000Z", "high");
  report("2026-10-09T22:00:00.000Z", "high");
  const { rpc } = fakeRuntime([review], ENERGY_ADVISOR);
  const advice = await computeEnergyAdvice(store, workspaceId, "C:\\repo", { client: rpc, review: true, now: NOW, webBlocker: () => undefined,
    safeGet: deps({ "https://example.edu/post-lunch-dip": () => page("The post-lunch dip in alertness | Example University") }) });
  if ("insufficient" in advice) throw new Error("expected advice");
  expect(advice.review.state).toBe("adjusted");
  expect(advice.sources.map((source) => source.id)).toEqual(["s1"]);
  expect(advice.review.findings).toHaveLength(1);
  expect(advice.review.adjustments.map((item) => item.start)).toEqual(["13:00"]);
  expect(advice.review.droppedSources).toBe(1);
  expect(advice.summary).toBe("午后低谷有一致证据，13–14 时下调一级。");
  // 13:00–14:00 is one level under the rule there; the person's 16–18 band stays high.
  expect(advice.levels[3]![26]).toBe(Math.max(1, advice.ruleLevels[3]![26]! - 1));
  expect(advice.levels[3]![33]).toBe(3);
  expect(readEnergyAdvice(store.getSetting(workspaceId, ENERGY_ADVICE_SETTING))).toMatchObject({ id: advice.id });
  expect(store.listEvents(workspaceId, { type: "energy.advice.computed" })).toHaveLength(1);
});

test("the pass does nothing while paused or the person is away, and skips only the review when the quota is tight", async () => {
  report("2026-10-07T21:30:00.000Z", "high");
  report("2026-10-09T22:00:00.000Z", "high");
  const base = { store, workspaceId, cwd: "C:\\repo", client: () => undefined };
  await energyAdvicePass({ ...base, paused: () => true, spend: async () => ({ mode: "normal", engagement: "active" }) as never });
  expect(store.getSetting(workspaceId, ENERGY_ADVICE_SETTING)).toBeFalsy();
  await energyAdvicePass({ ...base, paused: () => false, spend: async () => ({ mode: "normal", engagement: "dormant" }) as never });
  expect(store.getSetting(workspaceId, ENERGY_ADVICE_SETTING)).toBeFalsy();
  await energyAdvicePass({ ...base, paused: () => false, spend: async () => ({ mode: "economy", engagement: "active" }) as never });
  const advice = readEnergyAdvice(store.getSetting(workspaceId, ENERGY_ADVICE_SETTING));
  expect(advice && !("insufficient" in advice) && advice.review).toMatchObject({ state: "skipped", summary: "额度偏紧，本周未做联网复核" });
});
