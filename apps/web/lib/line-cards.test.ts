import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { LINE_SETTING } from "@crossline/identity-packs";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({})), CodexSupervisorRequestError: class extends Error {} }));
import { requestCodexSupervisor } from "./codex-runtime";
import { decideGoalEdit, lineCardDetails, recordRedraftRequested, redraftDue } from "./line-cards";
import { identityLines, updateLine } from "./lines";
import { executeAction } from "./actions";
import { conciergeSnapshot, contextPack } from "./conversation";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.clearAllMocks(); });
const ws = TEST_CTX.workspaceId;

function setup() {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.setSetting(ws, LINE_SETTING, JSON.stringify([
    { id: "research", label: "研究者", color: "research", goal: "成为神经形态计算方向能独立立项的研究者", goals: ["成为神经形态计算方向能独立立项的研究者", "成为能带学生的研究者"], createdAt: "" },
    { id: "line-media", label: "创作者", color: "media", goal: "", goals: [], createdAt: "" }]));
  return store;
}

test("adopting attributes writes the parts in order and the composed sentence as goals[0]; the other goals stay", () => {
  setup();
  expect(updateLine(TEST_CTX, "research", { goalParts: ["器件物理方向", " 能独立立项的 "] })).toEqual({ ok: true });
  const line = identityLines(TEST_CTX).find((item) => item.id === "research")!;
  expect(line.goalParts).toEqual(["器件物理方向", "能独立立项"]);
  expect(line.goals).toEqual(["成为器件物理方向的、能独立立项的研究者", "成为能带学生的研究者"]);
  expect(line.goal).toBe("成为器件物理方向的、能独立立项的研究者");
  // A renamed line's composed goal follows the new name.
  expect(updateLine(TEST_CTX, "research", { label: "科研者" })).toEqual({ ok: true });
  expect(identityLines(TEST_CTX).find((item) => item.id === "research")!.goals?.[0]).toBe("成为器件物理方向的、能独立立项的科研者");
  // A goal rewritten as a whole sentence drops parts that no longer compose it.
  expect(updateLine(TEST_CTX, "research", { goals: ["成为能写好论文的科研者"] })).toEqual({ ok: true });
  expect(identityLines(TEST_CTX).find((item) => item.id === "research")!.goalParts).toBeUndefined();
});

test("parts are checked: none, overlapping or not a list are refused with the reason", () => {
  setup();
  expect(updateLine(TEST_CTX, "research", { goalParts: [] })).toMatchObject({ ok: false, code: "LINE_GOAL_PARTS_EMPTY" });
  expect(updateLine(TEST_CTX, "research", { goalParts: ["神经形态计算", "神经形态计算方向"] })).toMatchObject({ ok: false, code: "LINE_GOAL_PARTS_DUPLICATE",
    message: "「神经形态计算」与「神经形态计算方向」重复" });
  expect(updateLine(TEST_CTX, "research", { goalParts: "科普" as unknown as string[] })).toMatchObject({ ok: false, code: "LINE_GOAL_PARTS_INVALID" });
  expect(identityLines(TEST_CTX).find((item) => item.id === "research")!.goals?.[0]).toBe("成为神经形态计算方向能独立立项的研究者");
});

test("the redraft offer appears when the goal or the facts moved after the last proposal, and only for a line with milestones", () => {
  const base = { goalChangedAt: "", factChangedAt: "", lastDraftAt: "2026-10-09T10:00:00Z", hasMilestones: true };
  expect(redraftDue(base)).toBe(false);
  expect(redraftDue({ ...base, factChangedAt: "2026-10-09T11:00:00Z" })).toBe(true);
  expect(redraftDue({ ...base, goalChangedAt: "2026-10-09T11:00:00Z" })).toBe(true);
  expect(redraftDue({ ...base, goalChangedAt: "2026-10-09T09:00:00Z" })).toBe(false);
  expect(redraftDue({ ...base, factChangedAt: "2026-10-09T11:00:00Z", hasMilestones: false })).toBe(false);
});

test("a card reads its line's description, candidates, pending goal change, own interview and whether to offer a redraft", () => {
  const store = setup();
  store.setSetting(ws, "lines.profiles", JSON.stringify({ research: { description: "器件到算法", attributes: [{ text: "器件物理", kind: "domain", sourceRef: "reply-1" }] },
    "line-media": { description: "科普", goalCandidates: ["成为有影响力的科普创作者"] } }));
  store.setSetting(ws, "lines.goalEdits", JSON.stringify({ research: { parts: ["器件物理"], sourceRef: "reply-2", at: "2026-10-09T00:00:00Z" } }));
  store.saveMilestone({ id: "m1", ownerId: TEST_CTX.principalId, workspaceId: ws, identityId: "research", title: "投出西湖论文", version: 1, status: "draft" });
  store.appendEvent({ ownerId: TEST_CTX.principalId, workspaceId: ws, idempotencyKey: "p:m1", type: "milestone.proposed", entityId: "m1", payload: {} });
  store.appendOnboardingMessage({ sessionId: "line-research", workspaceId: ws, role: "user", content: { text: "数据下周到" }, createdAt: "2026-10-09T00:00:00Z" });
  store.appendOnboardingMessage({ sessionId: "line-research", workspaceId: ws, role: "assistant", createdAt: "2026-10-09T00:01:00Z",
    content: { reply: "数据到之前先写方法部分。", questions: [{ id: "q1", text: "导师何时审阅？", kind: "single", allowOther: true, identityId: "research", projectId: "",
      options: [{ id: "a", label: "本周", detail: "" }, { id: "b", label: "下周", detail: "" }] }] } });
  let details = lineCardDetails(TEST_CTX);
  expect(details.research).toMatchObject({ description: "器件到算法", attributes: [{ text: "器件物理", kind: "domain" }], pendingEdit: { parts: ["器件物理"] },
    redraftDue: false, interview: { reply: "数据到之前先写方法部分。", waiting: false, turns: 1 } });
  expect(details.research!.interview.questions[0]).toMatchObject({ id: "q1", options: [{ label: "本周" }, { label: "下周" }] });
  // An old whole-sentence candidate reads as one attribute.
  expect(details["line-media"]!.attributes).toEqual([{ text: "有影响力的科普", kind: "state", sourceRef: "" }]);
  // A fact learned later puts the offer up; asking for the redraft takes it down until something moves again.
  store.upsertProfileFact({ workspaceId: ws, identityId: "research", projectId: "", slot: "advisor", value: "导师下周审阅", status: "confirmed",
    sourceRef: "reply-3", sourceQuote: "下周", updatedAt: "2999-01-01T00:00:00Z" });
  expect(lineCardDetails(TEST_CTX).research!.redraftDue).toBe(true);
  store.upsertProfileFact({ workspaceId: ws, identityId: "research", projectId: "", slot: "advisor", value: "导师下周审阅", status: "confirmed",
    sourceRef: "reply-3", sourceQuote: "下周", updatedAt: new Date(Date.now() - 1000).toISOString() });
  recordRedraftRequested(TEST_CTX, ["research"]);
  details = lineCardDetails(TEST_CTX);
  expect(details.research!.redraftDue).toBe(false);
  expect(updateLine(TEST_CTX, "research", { goalParts: ["器件物理"] })).toEqual({ ok: true });
  expect(lineCardDetails(TEST_CTX).research!.redraftDue).toBe(true);
});

test("a goal change from the interview takes effect only on the person's click, and either answer clears it", () => {
  const store = setup();
  store.setSetting(ws, "lines.goalEdits", JSON.stringify({ research: { parts: ["器件物理方向", "能独立立项"], sourceRef: "reply-2", at: "t1" },
    "line-media": { parts: ["科普"], sourceRef: "reply-3", at: "t2" } }));
  expect(decideGoalEdit(TEST_CTX, "research", "adopt")).toEqual({ ok: true });
  expect(identityLines(TEST_CTX).find((item) => item.id === "research")!.goals?.[0]).toBe("成为器件物理方向的、能独立立项的研究者");
  expect(decideGoalEdit(TEST_CTX, "line-media", "dismiss")).toEqual({ ok: true });
  expect(identityLines(TEST_CTX).find((item) => item.id === "line-media")!.goals).toEqual([]);
  expect(JSON.parse(store.getSetting(ws, "lines.goalEdits")!)).toEqual({});
  expect(store.listEvents(ws, { type: ["line.goal_edit_adopted", "line.goal_edit_dismissed"] }).map((event) => [event.type, event.entityId]))
    .toEqual([["line.goal_edit_adopted", "research"], ["line.goal_edit_dismissed", "line-media"]]);
  expect(decideGoalEdit(TEST_CTX, "research", "adopt")).toMatchObject({ ok: false, code: "GOAL_EDIT_NOT_FOUND" });
});

test("on a line's card the 小助手 knows the line, and what is said about it goes to that line's own interview", async () => {
  const store = setup();
  store.setSetting(ws, "lines.profiles", JSON.stringify({ research: { description: "器件到算法", attributes: [] } }));
  const pack = await contextPack(TEST_CTX, { kind: "line", entityId: "research" }, new Date("2026-10-09T15:00:00Z"));
  expect(pack.page).toEqual({ kind: "line", entityId: "research", title: "研究者" });
  const snapshot = conciergeSnapshot(pack, new Date("2026-10-09T15:00:00Z"));
  expect(snapshot).toContain("本页主线：research | 研究者");
  expect(snapshot).toContain("访谈对该主线的描述：器件到算法");
  expect(snapshot).toContain("lineId 填 research");
  const told = await executeAction(TEST_CTX, { action: "profile.tell", summary: "", args: { text: "把长期目标改成器件物理方向能独立立项的研究者", lineId: "research" } });
  expect(told).toMatchObject({ ok: true, href: "/milestones?line=research" });
  expect(vi.mocked(requestCodexSupervisor)).toHaveBeenCalledWith(TEST_CTX, "/v1/onboarding/turn", expect.objectContaining({
    body: JSON.stringify({ sessionId: "line-research", text: "把长期目标改成器件物理方向能独立立项的研究者" }) }));
  expect(await executeAction(TEST_CTX, { action: "profile.tell", summary: "", args: { text: "x", lineId: "ghost" } })).toMatchObject({ ok: false });
  void store;
});
