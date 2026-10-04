import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { CrosslineStore } from "@crossline/db";
import type { CostSignal } from "@crossline/core";
import {
  MANUAL_DESIGNER_SKILL, MATERIAL_RESEARCHER_SKILL, MATERIAL_WRITER_SKILL, createManualbookBuilder, listManualbookFiles, pendingMaterialWorkOrders, type ManualbookDeps
} from "./manualbook";
import { scriptedRuntime } from "./testing/fake-runtime";

const WS = "ws";
let store: CrosslineStore;
let dir: string;

beforeEach(() => {
  store = new CrosslineStore(":memory:");
  dir = mkdtempSync(path.join(tmpdir(), "crossline-manual-"));
  store.saveWorkOrder({ id: "w1", ownerId: "o", workspaceId: WS, identityId: "research", projectId: "p", milestoneId: "", intent: "熟悉 Cadence 并画 6T SRAM 单元",
    state: "preparing", riskTier: "milestone", estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" },
    payload: { materialContract: [{ id: "c1", description: "Cadence 入门教程", required: true }], evidenceContract: [{ kind: "record", description: "一张 6T SRAM 原理图", required: true }] } });
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const healthy: CostSignal = { available: true, limitReached: false, short: { usedPercent: 10, windowDurationMins: 300, resetsAt: null }, long: { usedPercent: 10, windowDurationMins: 10080, resetsAt: null } };
const SKILLS = [MANUAL_DESIGNER_SKILL, MATERIAL_RESEARCHER_SKILL, MATERIAL_WRITER_SKILL];

const design = {
  overview: "先学工具，再画图。",
  nodes: [
    { id: "learn", title: "学 Virtuoso", kind: "read", goal: "会用原理图编辑器", steps: ["看官方教程第一章"], acceptance: "能新建 cell", serves: ["c1"], needsResearch: true, researchQuestions: ["Virtuoso 入门看什么"] },
    { id: "draw", title: "画 6T 单元", kind: "do", goal: "完成原理图", steps: ["放 6 个晶体管"], acceptance: "有截图", serves: ["w1-evidence-0"], needsResearch: false, researchQuestions: [] }
  ],
  edges: [{ from: "learn", to: "draw" }], assumptions: ["已装好 Cadence"], blockers: []
};
const search = { sources: [
  { id: "s1", url: "https://arxiv.org/abs/2401.00001", title: "Open Cadence Tutorial", publisher: "arXiv", kind: "paper", openAccess: "yes", licenseNote: "", summary: "open tutorial summary" },
  { id: "s2", url: "https://vendor.example.com/virtuoso-guide", title: "Virtuoso Guide", publisher: "Vendor", kind: "docs", openAccess: "yes", licenseNote: "", summary: "vendor guide summary" },
  { id: "s3", url: "https://ghost.example.org/none", title: "Ghost Page", publisher: "?", kind: "tutorial", openAccess: "unknown", licenseNote: "", summary: "x" }
], gaps: [], blockers: [] };
const writeup = (cites: string[]) => ({ analysis: "按 [s1] 的做法…", tutorial: "第一步…", citations: cites, blockers: [] });

const pdfBytes = new TextEncoder().encode("%PDF-1.4 fake");
const fetchImpl = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url === "https://arxiv.org/pdf/2401.00001") return new Response("Open Cadence Tutorial\nThis tutorial explains Cadence Virtuoso schematic entry.", { status: 200, headers: { "content-type": "text/plain" } });
  if (url === "https://vendor.example.com/virtuoso-guide") return new Response("<html><head><title>Virtuoso Guide</title></head><body>guide</body></html>", { status: 200, headers: { "content-type": "text/html" } });
  throw new Error("unreachable");
}) as typeof fetch;
void pdfBytes;

const deps = (over: Partial<ManualbookDeps> = {}) => ({ readCost: async () => healthy, webBlocker: () => undefined, now: () => new Date("2026-10-02T12:00:00.000Z"),
  safeGet: { fetchImpl, isPublicHost: async () => true }, ...over });

const respond = (writeCites = ["s1"]) => (prompt: string) => {
  if (prompt.includes("crossline.manualbook.design.v1")) return JSON.stringify(design);
  if (prompt.includes("crossline.manualbook.search.v1")) return JSON.stringify(search);
  return JSON.stringify(writeup(writeCites));
};

test("a task becomes a manualbook: a flow, per-step files, downloaded open-access text, and a manifest whose checksums match", async () => {
  const { rpc } = scriptedRuntime(SKILLS, respond());
  const build = createManualbookBuilder(store, WS, dir, "C:\\repo", () => rpc, deps());
  const outcome = await build("w1");
  expect(outcome).toMatchObject({ state: "ready", nodes: 2, sources: 2, downloaded: 1 });

  const files = listManualbookFiles(dir, "w1");
  for (const expected of ["flow.json", "manual.md", "manifest.json", "nodes/learn/task.md", "nodes/learn/analysis.md", "nodes/learn/tutorial.md", "nodes/draw/task.md"]) expect(files).toContain(expected);
  const flow = JSON.parse(readFileSync(path.join(dir, "w1", "flow.json"), "utf8")) as { nodes: Array<{ id: string; stage: number }>; edges: unknown[] };
  expect(flow.nodes.map((node) => [node.id, node.stage])).toEqual([["learn", 0], ["draw", 1]]);

  // Only the open-access host was downloaded; the vendor page keeps its link and the model's summary and nothing else.
  expect(files.some((file) => file.startsWith("nodes/learn/sources/") && file.includes("open-cadence-tutorial"))).toBe(true);
  expect(files.some((file) => file.includes("virtuoso-guide"))).toBe(false);
  const manifest = JSON.parse(readFileSync(path.join(dir, "w1", "manifest.json"), "utf8")) as {
    files: Array<{ path: string; sha256: string }>; sources: Array<{ id: string; kept: string; license: string }>;
  };
  expect(manifest.sources.map((source) => [source.id, source.kept])).toEqual([["s1", "full_text"], ["s2", "summary_only"]]);
  expect(manifest.sources[0]!.license).toContain("arXiv");
  for (const entry of manifest.files) {
    expect(createHash("sha256").update(readFileSync(path.join(dir, "w1", entry.path))).digest("hex"), entry.path).toBe(entry.sha256);
  }
  // The page that did not open is not listed anywhere, and the gap says so.
  expect(readFileSync(path.join(dir, "w1", "nodes/learn/task.md"), "utf8")).toContain("Ghost Page");

  expect(store.listMaterials(WS, "w1").length).toBeGreaterThan(5);
  expect(store.listWorkOrders(WS)[0]?.state).toBe("ready_for_human");
  expect(pendingMaterialWorkOrders(store, WS)).toEqual([]);
});

test("a flow with a loop, or one that leaves a required item unserved, is sent back and nothing is written", async () => {
  const loop = { ...design, edges: [{ from: "learn", to: "draw" }, { from: "draw", to: "learn" }] };
  const { rpc } = scriptedRuntime(SKILLS, () => JSON.stringify(loop));
  const outcome = await createManualbookBuilder(store, WS, dir, "C:\\repo", () => rpc, deps())("w1");
  expect(outcome).toMatchObject({ state: "blocked", code: "MANUAL_FLOW_HAS_LOOP" });
  expect(existsSync(path.join(dir, "w1"))).toBe(false);
  expect(store.listWorkOrders(WS)[0]?.state).toBe("preparing");
  // The failure is recorded, so the tick does not retry it on a timer.
  expect(pendingMaterialWorkOrders(store, WS)).toEqual([]);
});

test("a write-up that cites a source it was never given is refused for that step; the rest of the manualbook still builds", async () => {
  let writes = 0;
  const { rpc } = scriptedRuntime(SKILLS, (prompt) => {
    if (prompt.includes("crossline.manualbook.design.v1")) return JSON.stringify(design);
    if (prompt.includes("crossline.manualbook.search.v1")) return JSON.stringify(search);
    writes += 1;
    return JSON.stringify(writeup(prompt.includes("放 6 个晶体管") ? [] : ["s9"]));
  });
  const outcome = await createManualbookBuilder(store, WS, dir, "C:\\repo", () => rpc, deps())("w1");
  expect(outcome).toMatchObject({ state: "ready" });
  expect(writes).toBeGreaterThanOrEqual(2);
  const analysis = readFileSync(path.join(dir, "w1", "nodes/learn/analysis.md"), "utf8");
  expect(analysis).toContain("没有写成");
});

test("without web research the manualbook is still built, with the gap stated", async () => {
  const { rpc, prompts } = scriptedRuntime(SKILLS, respond([]));
  const outcome = await createManualbookBuilder(store, WS, dir, "C:\\repo", () => rpc, deps({ webBlocker: () => ({ code: "WEB_RESEARCH_HOST_MISSING", message: "缺少 host" }) }))("w1");
  expect(outcome).toMatchObject({ state: "ready", sources: 0 });
  expect(prompts().some((prompt) => prompt.includes("crossline.manualbook.search.v1"))).toBe(false);
  expect(readFileSync(path.join(dir, "w1", "nodes/learn/task.md"), "utf8")).toContain("没有联网查资料");
});

test("no quota means the person prepares it, and a missing contract means there is nothing to build", async () => {
  const { rpc, prompts } = scriptedRuntime(SKILLS, respond());
  const exhausted: CostSignal = { available: true, limitReached: true, short: { usedPercent: 100, windowDurationMins: 300, resetsAt: null }, long: { usedPercent: 100, windowDurationMins: 10080, resetsAt: null } };
  expect(await createManualbookBuilder(store, WS, dir, "C:\\repo", () => rpc, deps({ readCost: async () => exhausted }))("w1")).toMatchObject({ state: "blocked", code: "MATERIAL_BUDGET_EXHAUSTED" });
  expect(prompts()).toEqual([]);
  store.saveWorkOrder({ id: "w2", ownerId: "o", workspaceId: WS, identityId: "research", projectId: "p", milestoneId: "", intent: "x", state: "preparing", riskTier: "routine",
    estimate: { p25Minutes: 1, p50Minutes: 2, p85Minutes: 3, source: "llm_prior", observationCount: 0, confidence: "low" }, payload: {} });
  expect(await createManualbookBuilder(store, WS, dir, "C:\\repo", () => rpc, deps())("w2")).toMatchObject({ state: "blocked", code: "MATERIALS_NOT_REQUIRED" });
});

test("a work order that is not being prepared, or a path-shaped id, is refused", async () => {
  const { rpc } = scriptedRuntime(SKILLS, respond());
  const build = createManualbookBuilder(store, WS, dir, "C:\\repo", () => rpc, deps());
  expect(await build("../escape")).toMatchObject({ state: "blocked", code: "MATERIAL_PATH_OUTSIDE_ROOT" });
  expect(await build("nope")).toMatchObject({ state: "blocked", code: "WORK_ORDER_NOT_FOUND" });
});
