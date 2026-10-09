import { expect, test } from "vitest";
import {
  openAccessVerdict, topologicalOrder, validateManualDesign, validateMaterialSearch, validateNodeWriteup,
  type ManualDesign, type ManualDesignContext, type ManualNode, type WriteContext
} from "./manualbook-schema";

const context: ManualDesignContext = {
  version: "crossline.manualbook.design.v1", today: "2026-10-02",
  workOrder: { id: "wo", intent: "熟悉 Cadence 并画 6T SRAM 单元", identityId: "research", milestone: null },
  contract: [{ id: "c1", kind: "material", description: "Cadence Virtuoso 入门教程", required: true }, { id: "c2", kind: "evidence", description: "一张 6T SRAM 原理图截图", required: true },
    { id: "c3", kind: "material", description: "可选：课程幻灯片", required: false }],
  inputs: [], localFiles: [], profile: [], constraints: []
};
const node = (id: string, over: Partial<ManualNode> = {}): ManualNode => ({ id, title: `步骤 ${id}`, kind: "do", goal: "目标", steps: ["做一件事"], acceptance: "做到了",
  serves: [], needsResearch: true, researchQuestions: ["教材怎么讲", "官方文档在哪"], ...over });
const design = (over: Partial<ManualDesign> = {}): ManualDesign => ({
  overview: "总览", nodes: [node("learn", { serves: ["c1"], needsResearch: true, researchQuestions: ["Virtuoso 入门看什么", "官方教程在哪"] }), node("draw", { serves: ["c2"] })],
  edges: [{ from: "learn", to: "draw" }], assumptions: [], blockers: [], ...over
});
const refused = (value: unknown, code: string) => {
  try { validateManualDesign(value, context); } catch (error) { expect((error as Error).message).toBe(code); return; }
  throw new Error(`expected ${code}`);
};

test("a connected, loop-free flow that serves every required item is accepted", () => {
  expect(validateManualDesign(design(), context).nodes).toHaveLength(2);
});

test("ids, edges, loops and loose steps are refused with the step named", () => {
  refused(design({ nodes: [node("Learn", { serves: ["c1", "c2"] })], edges: [] }), "MANUAL_NODE_ID_INVALID");
  refused(design({ nodes: [node("a", { serves: ["c1"] }), node("a", { serves: ["c2"] })] }), "MANUAL_NODE_ID_DUPLICATE");
  refused(design({ edges: [{ from: "learn", to: "ghost" }] }), "MANUAL_EDGE_UNKNOWN_NODE");
  refused(design({ edges: [{ from: "learn", to: "learn" }] }), "MANUAL_EDGE_SELF");
  refused(design({ edges: [{ from: "learn", to: "draw" }, { from: "draw", to: "learn" }] }), "MANUAL_FLOW_HAS_LOOP");
  refused(design({ nodes: [...design().nodes, node("orphan")] }), "MANUAL_NODE_DISCONNECTED");
});

test("every required item needs a step that serves it, and a step cannot serve an item that does not exist", () => {
  refused(design({ nodes: [node("learn", { serves: ["c1"], needsResearch: true, researchQuestions: ["q", "r"] }), node("draw")] }), "MANUAL_CONTRACT_UNSERVED");
  refused(design({ nodes: [node("learn", { serves: ["nope"] }), node("draw", { serves: ["c2"] })] }), "MANUAL_CONTRACT_UNKNOWN");
  // The optional item may go unserved.
  expect(() => validateManualDesign(design(), context)).not.toThrow();
});

test("a step that needs research must say what to look for", () => {
  refused(design({ nodes: [node("learn", { serves: ["c1"], researchQuestions: ["只有一个"] }), node("draw", { serves: ["c2"] })] }), "MANUAL_RESEARCH_QUESTION_MISSING");
  refused(design({ nodes: [node("learn", { serves: ["c1"], needsResearch: false }), node("draw", { serves: ["c2"] })] }), "MANUAL_RESEARCH_QUESTION_MISSING");
});

test("topological order puts every step after what it depends on, and is absent for a loop", () => {
  expect(topologicalOrder(["a", "b", "c"], [{ from: "a", to: "b" }, { from: "b", to: "c" }])).toEqual(["a", "b", "c"]);
  expect(topologicalOrder(["a", "b"], [{ from: "a", to: "b" }, { from: "b", to: "a" }])).toBeUndefined();
});

const source = (over: object = {}) => ({ id: "s1", url: "https://arxiv.org/abs/1706.03762", title: "Attention", publisher: "arXiv", kind: "paper", openAccess: "yes", licenseNote: "", summary: "s", ...over });
test("only public https pages are accepted as found sources", () => {
  expect(() => validateMaterialSearch({ sources: [source()], gaps: [], blockers: [] })).not.toThrow();
  for (const url of ["http://arxiv.org/abs/1", "https://127.0.0.1/a", "https://example.com:8443/a"]) {
    expect(() => validateMaterialSearch({ sources: [source({ url })], gaps: [], blockers: [] }), url).toThrow("MANUAL_SOURCE_URL_INVALID");
  }
});

test("a full text is kept only from an open-access host AND when the model did not say it is closed", () => {
  expect(openAccessVerdict({ url: "https://arxiv.org/abs/1706.03762", openAccess: "yes" })).toMatchObject({ download: true });
  expect(openAccessVerdict({ url: "https://arxiv.org/abs/1706.03762", openAccess: "unknown" })).toMatchObject({ download: true });
  expect(openAccessVerdict({ url: "https://arxiv.org/abs/1706.03762", openAccess: "no" })).toMatchObject({ download: false });
  // The model saying "open access" about a publisher's paywalled page changes nothing: the host is not on the list.
  expect(openAccessVerdict({ url: "https://www.sciencedirect.com/science/article/pii/X", openAccess: "yes" })).toMatchObject({ download: false });
  expect(openAccessVerdict({ url: "http://arxiv.org/abs/1", openAccess: "yes" })).toMatchObject({ download: false });
});

const write: WriteContext = { version: "crossline.manualbook.write.v1", today: "2026-10-02", task: { intent: "x" },
  node: { id: "learn", title: "学习", kind: "read", goal: "g", steps: ["s"], acceptance: "a" },
  sources: [{ id: "s1", title: "Cadence tutorial", url: "https://docs.example.edu/virtuoso", kept: "full_text", text: "..." }], inputs: [], profile: [] };
test("a write-up must cite sources it was given, and may not invent an address", () => {
  const good = { analysis: "按 [s1] 的做法…", tutorial: "第一步…", citations: ["s1"], blockers: [] };
  expect(() => validateNodeWriteup(good, write)).not.toThrow();
  expect(() => validateNodeWriteup({ ...good, citations: ["s9"] }, write)).toThrow("MANUAL_CITATION_UNKNOWN");
  expect(() => validateNodeWriteup({ ...good, citations: [] }, write)).toThrow("MANUAL_WRITEUP_UNCITED");
  expect(() => validateNodeWriteup({ ...good, tutorial: "见 https://made-up.example.org/guide" }, write)).toThrow("MANUAL_URL_INVENTED");
  expect(() => validateNodeWriteup({ ...good, tutorial: "见 https://docs.example.edu/virtuoso/ch2" }, write)).not.toThrow();
  expect(() => validateNodeWriteup({ ...good, citations: [] }, { ...write, sources: [] })).not.toThrow();
});

test("downloading an open-access page needs no approval; keeping any other page's text is never allowed", async () => {
  const { requiredApproval } = await import("./index");
  expect(requiredApproval("download_open_access")).toBe("automatic");
  expect(requiredApproval("download_other")).toBe("never");
});
