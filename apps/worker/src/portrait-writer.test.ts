import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { LINE_SETTING } from "@crossline/identity-packs";
import { ENERGY_CATEGORIES, PORTRAIT_SCHEMA_VERSION, SAY_DO_DIMENSIONS, SCHWARTZ_VALUES, type PortraitReport } from "@crossline/core";
import { createPortraitWriter, PORTRAIT_REWRITE_MARKER, PORTRAIT_WRITER, portraitRewriteDue } from "./portrait-writer";
import { fakeRuntime } from "./testing/fake-runtime";

const SKILL = readFileSync(path.resolve(import.meta.dirname, "../../../skills/marketplace/plugins/crossline/skills/crossline-portrait-writer/SKILL.md"), "utf8");

let store: CrosslineStore;
let workspaceId: string;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  workspaceId = store.createPrincipalWithWorkspace("user-1", "个人 workspace").workspace.id;
  store.setSetting(workspaceId, LINE_SETTING, JSON.stringify([{ id: "research", label: "研究者", color: "research", goal: "", goals: [], createdAt: "" }]));
});
afterEach(() => store.close());

const report = (overrides: Partial<PortraitReport> = {}): PortraitReport => ({
  cover: { portrait: "一名研究者。", coreConflict: "精力分散", keywords: ["研究"], tagline: "把研究做成产品", coreWord: "系统化" },
  problem: { statement: "s", gravity: [], designable: [], reframes: [] },
  compass: { workView: "w", lifeView: "l", consistency: "c", trueNorth: "n", values: SCHWARTZ_VALUES.map((value, index) => ({ name: value.name, score: 30 + index * 5, evidence: "e" })) },
  energy: { summary: "", flow: [], map: [{ activity: "写代码", skill: "high", love: "high", charge: "charge", skillScore: 80, loveScore: 80, category: ENERGY_CATEGORIES[0] }] },
  lines: { allocation: "", items: [{ lineId: "research", description: "d", goals: [], feeds: [], share: 100, targetShare: 100 }] },
  gap: { says: "说", does: "做", reading: "r", anchor: "a", realWant: "w", reframe: "f", pairs: SAY_DO_DIMENSIONS.map((dimension) => ({ dimension: dimension.label, says: 60, evidence: "e" })) },
  insights: [], sensitive: [], ...overrides
});
const saved = () => JSON.parse(store.getSetting(workspaceId, "portrait.report")!) as { version: number; at: string; schema?: number; report: PortraitReport };

test("the Skill describes the contract: core word, the ten values, six energy categories, five say–do dimensions and the ledger's doing", () => {
  expect(SKILL).toContain("coreWord");
  for (const value of SCHWARTZ_VALUES) expect(SKILL).toContain(value.name);
  for (const category of ENERGY_CATEGORIES) expect(SKILL).toContain(category);
  for (const dimension of SAY_DO_DIMENSIONS) expect(SKILL).toContain(dimension.label);
  expect(SKILL).toContain("doing");
  expect(SKILL).not.toContain("5–8 things");
});

test("the report is saved with its schema version, and the model is given what the ledger says was done", async () => {
  const runtime = fakeRuntime([JSON.stringify(report())], PORTRAIT_WRITER);
  expect(await createPortraitWriter(store, workspaceId, "C:\\repo", () => runtime.rpc)()).toEqual({ state: "written", version: 1 });
  expect(saved()).toMatchObject({ version: 1, schema: PORTRAIT_SCHEMA_VERSION });
  expect(runtime.prompts()[0]).toContain("\"doing\"");
  expect(runtime.prompts()[0]).toContain("\"sufficient\":false");
});

test("an answer whose values stay incomplete after the repairs is kept; an unknown line is still refused", async () => {
  const nine = report({ compass: { ...report().compass, values: report().compass.values!.slice(0, 9) } });
  const runtime = fakeRuntime([JSON.stringify(nine), JSON.stringify(nine), JSON.stringify(nine)], PORTRAIT_WRITER);
  expect(await createPortraitWriter(store, workspaceId, "C:\\repo", () => runtime.rpc)()).toMatchObject({ state: "written" });
  expect(saved().report.compass.values).toHaveLength(9);
  const ghost = report({ lines: { allocation: "", items: [{ lineId: "ghost", description: "", goals: [], feeds: [] }] } });
  const refused = fakeRuntime([JSON.stringify(ghost), JSON.stringify(ghost), JSON.stringify(ghost)], PORTRAIT_WRITER);
  expect(await createPortraitWriter(store, workspaceId, "C:\\repo", () => refused.rpc)()).toMatchObject({ state: "blocked" });
});

const NOW = new Date("2026-10-12T12:00:00.000Z");
const keep = (value: object) => store.setSetting(workspaceId, "portrait.report", JSON.stringify(value));
// Ten finished sessions from twenty days back: enough for the say–do readings to be drawn.
function enoughExecutions() {
  for (let index = 0; index < 10; index += 1) {
    const id = `o${index}`;
    const day = new Date(NOW.getTime() - (20 - index) * 86_400_000).toISOString().slice(0, 10);
    store.saveWorkOrder({ id, ownerId: "o", workspaceId, identityId: "research", projectId: "p", milestoneId: "m", intent: id, state: "ready_for_human", riskTier: "routine",
      estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" }, payload: { materialContract: [], evidenceContract: [] } });
    store.transitionWorkOrder(workspaceId, id, { type: "human.started" }, `s:${id}`, { occurredAt: `${day}T09:00:00.000Z` });
    store.transitionWorkOrder(workspaceId, id, { type: "human.completed" }, `d:${id}`, { occurredAt: `${day}T10:00:00.000Z` });
  }
}

test("an old report is rewritten once after the new version ships; never twice, never over a run in progress", () => {
  expect(portraitRewriteDue(store, workspaceId, NOW)).toBeNull();
  keep({ version: 3, at: "2026-10-01T00:00:00.000Z", report: report() });
  expect(portraitRewriteDue(store, workspaceId, NOW)).toBe("schema");
  keep({ version: 3, at: "2026-10-01T00:00:00.000Z", schema: 1, report: report() });
  expect(portraitRewriteDue(store, workspaceId, NOW)).toBe("schema");
  store.appendEvent({ ownerId: "o", workspaceId, idempotencyKey: "req", type: "portrait.requested", entityId: workspaceId, payload: {} });
  expect(portraitRewriteDue(store, workspaceId, new Date())).toBeNull();
  store.setSetting(workspaceId, PORTRAIT_REWRITE_MARKER, "2026-10-14T00:00:00.000Z");
  expect(portraitRewriteDue(store, workspaceId, NOW)).toBeNull();
});

test("the marker is per schema version: a report rewritten for schema 2 is rewritten once more for 3", () => {
  store.setSetting(workspaceId, "portrait.rewrite.v2", "2026-10-12T00:00:00.000Z");
  keep({ version: 3, at: "2026-10-01T00:00:00.000Z", schema: 2, report: report() });
  expect(portraitRewriteDue(store, workspaceId, NOW)).toBe("schema");
  store.setSetting(workspaceId, PORTRAIT_REWRITE_MARKER, "2026-10-14T00:00:00.000Z");
  expect(portraitRewriteDue(store, workspaceId, NOW)).toBeNull();
});

test("the say–do part is rewritten at most monthly, once there is enough record; the old schema comes first", () => {
  keep({ version: 2, at: "2026-10-01T00:00:00.000Z", schema: PORTRAIT_SCHEMA_VERSION, report: report() });
  expect(portraitRewriteDue(store, workspaceId, NOW)).toBeNull();
  enoughExecutions();
  expect(portraitRewriteDue(store, workspaceId, NOW)).toBe("gap");
  store.setSetting(workspaceId, "portrait.gap.at", "2026-09-20T00:00:00.000Z");
  expect(portraitRewriteDue(store, workspaceId, NOW)).toBeNull();
  store.setSetting(workspaceId, "portrait.gap.at", "2026-09-10T00:00:00.000Z");
  expect(portraitRewriteDue(store, workspaceId, NOW)).toBe("gap");
  keep({ version: 2, at: "2026-10-01T00:00:00.000Z", schema: 1, report: report() });
  expect(portraitRewriteDue(store, workspaceId, NOW)).toBe("schema");
});

test("a say–do rewrite replaces the gap only: the rest, the version and the figure stay", async () => {
  const before = report();
  keep({ version: 4, at: "2026-10-01T00:00:00.000Z", schema: PORTRAIT_SCHEMA_VERSION, report: before });
  const gap = { ...before.gap, reading: "按计划投入偏低", pairs: before.gap.pairs!.map((pair) => ({ ...pair, says: 80 })) };
  const runtime = fakeRuntime([JSON.stringify({ gap })], PORTRAIT_WRITER);
  expect(await createPortraitWriter(store, workspaceId, "C:\\repo", () => runtime.rpc, { only: "gap" })()).toEqual({ state: "written", version: 4 });
  const after = saved();
  expect(after).toMatchObject({ version: 4, at: "2026-10-01T00:00:00.000Z", schema: PORTRAIT_SCHEMA_VERSION });
  expect(after.report).toEqual({ ...before, gap });
  expect(runtime.prompts()[0]).toContain("\"previous\"");
  expect(store.getSetting(workspaceId, "portrait.gap.at")).toBeTruthy();
  expect(store.listEvents(workspaceId, { type: "portrait.gap_rewritten" })).toHaveLength(1);
  expect(store.listEvents(workspaceId, { type: "portrait.written" })).toHaveLength(0);
});

// 2026-10-15 walkthrough: the first report was asked for only by the interview page that saw the last round land.
test("with no report yet, a complete interview makes the first one due; an unfinished one does not", () => {
  expect(portraitRewriteDue(store, workspaceId, NOW)).toBeNull();
  store.saveOnboardingSession({ id: "s1", ownerId: "o", workspaceId, state: "active", coverage: {}, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
  expect(portraitRewriteDue(store, workspaceId, NOW)).toBeNull();
  store.saveOnboardingSession({ id: "s1", ownerId: "o", workspaceId, state: "complete", coverage: {}, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
  expect(portraitRewriteDue(store, workspaceId, NOW)).toBe("first");
});

test("the portrait reads the files the person uploaded about themselves, not the files read from an authorized folder", async () => {
  const owner = store.getWorkspaceOwnerId(workspaceId)!;
  const doc = (id: string, fileName: string, text: string) => store.saveSourceDocument({ id, ownerId: owner, workspaceId, kind: "text", fileName,
    mediaType: "text/markdown", sha256: id, uri: `file:///x/${id}`, extractedText: text, extractionStatus: "done", createdAt: "2026-10-19T00:00:00Z" });
  doc("lecture", "Entrepreneurship.pdf", "下载的讲义正文");
  doc("profile", "personal-profile.md", "本人自述");
  store.setSetting(workspaceId, "sources.folders", JSON.stringify([{ id: "f1", path: "C:\Users\me\Downloads" }]));
  store.setSetting(workspaceId, "sources.folder.index:f1", JSON.stringify({ "Entrepreneurship.pdf": { documentId: "lecture" } }));
  const runtime = fakeRuntime([JSON.stringify(report())], PORTRAIT_WRITER);
  await createPortraitWriter(store, workspaceId, "C:\repo", () => runtime.rpc)();
  expect(runtime.prompts()[0]).toContain("本人自述");
  expect(runtime.prompts()[0]).not.toContain("下载的讲义正文");
});
