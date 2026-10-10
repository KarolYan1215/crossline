import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { LINE_SETTING } from "@crossline/identity-packs";
import { composeGoal } from "@crossline/core";
import { createGoalSplitter, GOAL_SPLITTER, linesAwaitingCandidateSplit, linesAwaitingSplit } from "./goal-splitter";
import { identityLines } from "./lines";
import { fakeRuntime } from "./testing/fake-runtime";

let store: CrosslineStore;
let workspaceId: string;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  workspaceId = store.createPrincipalWithWorkspace("user-1", "个人 workspace").workspace.id;
  store.setSetting(workspaceId, LINE_SETTING, JSON.stringify([
    { id: "research", label: "研究者", color: "research", goal: "成为神经形态计算方向能独立立项的研究者", goals: ["成为神经形态计算方向能独立立项的研究者"], createdAt: "" },
    { id: "line-media", label: "创作者", color: "media", goal: "", goals: ["成为有影响力的科普创作者", "成为稳定更新的创作者"], createdAt: "" },
    { id: "line-empty", label: "投资者", color: "investment", goal: "", goals: [], createdAt: "" }]));
  store.setSetting(workspaceId, "lines.profiles", JSON.stringify({ "line-media": { description: "科普", goalCandidates: ["成为会剪辑的创作者"] } }));
});
afterEach(() => store.close());

const researchSplit = { lineId: "research", goals: [{ goal: "成为神经形态计算方向能独立立项的研究者",
  parts: [{ text: "神经形态计算方向", kind: "domain" }, { text: "能独立立项", kind: "ability" }] }] };
const mediaGood = { lineId: "line-media", goals: [
  { goal: "成为有影响力的科普创作者", parts: [{ text: "有影响力", kind: "state" }, { text: "科普", kind: "domain" }] },
  { goal: "成为稳定更新的创作者", parts: [{ text: "稳定更新", kind: "state" }] }] };
// Reworded: 「影响力大」 is not the sentence's own words, so it can never recompose.
const mediaReworded = { ...mediaGood, goals: [{ goal: "成为有影响力的科普创作者", parts: [{ text: "影响力大", kind: "state" }, { text: "科普", kind: "domain" }] }, mediaGood.goals[1]] };

test("only lines with an adopted goal and no attributes are waiting, each goal once", () => {
  expect(linesAwaitingSplit(store, workspaceId).map((line) => line.id)).toEqual(["research", "line-media"]);
});

test("each adopted goal is split, kept chosen, and the composed sentence is the one adopted; the wording is never touched", async () => {
  const runtime = fakeRuntime([JSON.stringify({ lines: [researchSplit, mediaGood] })], GOAL_SPLITTER);
  expect(await createGoalSplitter(store, workspaceId, "C:\\repo", () => runtime.rpc)()).toEqual({ split: 2 });
  const lines = identityLines(store, workspaceId);
  const research = lines.find((line) => line.id === "research")!;
  expect(research.goalParts).toEqual(["神经形态计算方向", "能独立立项"]);
  expect(research.goals).toEqual(["成为神经形态计算方向能独立立项的研究者"]);
  const media = lines.find((line) => line.id === "line-media")!;
  expect(media.goalParts).toEqual(["有影响力", "科普"]);
  expect(composeGoal(media.goalParts!, "创作者")).toBe("成为有影响力的、科普的创作者");
  // Every goal's parts join the line's candidates; the old whole-sentence candidate is carried over as an attribute.
  const profiles = JSON.parse(store.getSetting(workspaceId, "lines.profiles")!) as Record<string, { attributes: Array<{ text: string; sourceRef: string }> }>;
  expect(profiles["line-media"]!.attributes.map((item) => item.text)).toEqual(["会剪辑", "有影响力", "科普", "稳定更新"]);
  expect(profiles["line-media"]!.attributes.at(-1)!.sourceRef).toBe("goal");
  const events = store.listEvents(workspaceId, { type: "line.goal_split" });
  expect(events.map((event) => [event.entityId, (event.payload as { recomposed: boolean }).recomposed])).toEqual([["research", true], ["line-media", true]]);
  // Idempotent: nothing is waiting, and a second pass asks nothing.
  expect(linesAwaitingSplit(store, workspaceId)).toEqual([]);
  const again = fakeRuntime([], GOAL_SPLITTER);
  expect(await createGoalSplitter(store, workspaceId, "C:\\repo", () => again.rpc)()).toEqual({ split: 0 });
  expect(again.turns()).toBe(0);
});

test("a split that never recomposes is sent back, then the goal is kept whole as one attribute", async () => {
  const bad = JSON.stringify({ lines: [researchSplit, mediaReworded] });
  const runtime = fakeRuntime([bad, bad, bad], GOAL_SPLITTER);
  expect(await createGoalSplitter(store, workspaceId, "C:\\repo", () => runtime.rpc)()).toEqual({ split: 2 });
  expect(runtime.turns()).toBe(3);
  expect(runtime.prompts()[1]).toContain("与原句不一致");
  const media = identityLines(store, workspaceId).find((line) => line.id === "line-media")!;
  expect(media.goalParts).toEqual(["有影响力的科普"]);
  expect(media.goals?.[0]).toBe("成为有影响力的科普创作者");
  expect(identityLines(store, workspaceId).find((line) => line.id === "research")!.goalParts).toEqual(["神经形态计算方向", "能独立立项"]);
  // Kept whole is still a split: it is not tried again on every tick.
  expect(linesAwaitingSplit(store, workspaceId)).toEqual([]);
});

test("a goal the person changed while the model ran keeps their change, and is split later as a new goal", async () => {
  const runtime = fakeRuntime([() => {
    const specs = JSON.parse(store.getSetting(workspaceId, LINE_SETTING)!) as Array<{ id: string; goals: string[]; goal: string }>;
    specs[0]!.goals = ["成为器件物理方向的研究者"]; specs[0]!.goal = specs[0]!.goals[0]!;
    store.setSetting(workspaceId, LINE_SETTING, JSON.stringify(specs));
    return JSON.stringify({ lines: [researchSplit, mediaGood] });
  }], GOAL_SPLITTER);
  expect(await createGoalSplitter(store, workspaceId, "C:\\repo", () => runtime.rpc)()).toEqual({ split: 1 });
  const research = identityLines(store, workspaceId).find((line) => line.id === "research")!;
  expect(research.goalParts).toBeUndefined();
  expect(research.goals).toEqual(["成为器件物理方向的研究者"]);
  expect(linesAwaitingSplit(store, workspaceId).map((line) => line.id)).toEqual(["research"]);
});

test("without the runtime nothing is recorded and the lines stay waiting", async () => {
  expect(await createGoalSplitter(store, workspaceId, "C:\\repo", () => undefined)()).toEqual({ blocked: "CODEX_SUPERVISOR_UNAVAILABLE" });
  expect(linesAwaitingSplit(store, workspaceId)).toHaveLength(2);
});

test("a line with only the interview's old whole-sentence candidates gets them split once into independent attribute candidates", async () => {
  store.setSetting(workspaceId, "lines.profiles", JSON.stringify({ "line-media": { description: "科普", goalCandidates: ["成为会剪辑的创作者"] },
    "line-empty": { description: "", goalCandidates: ["成为外推人类知识边界的投资者", "成为以长期研究外推人类知识边界的投资者"] } }));
  expect(linesAwaitingCandidateSplit(store, workspaceId).map((line) => line.id)).toEqual(["line-media", "line-empty"]);
  const empty = { lineId: "line-empty", goals: [
    { goal: "成为外推人类知识边界的投资者", parts: [{ text: "外推人类知识边界", kind: "state" }] },
    { goal: "成为以长期研究外推人类知识边界的投资者", parts: [{ text: "以长期研究", kind: "ability" }, { text: "外推人类知识边界", kind: "state" }] }] };
  const runtime = fakeRuntime([JSON.stringify({ lines: [researchSplit, mediaGood, empty] })], GOAL_SPLITTER);
  expect(await createGoalSplitter(store, workspaceId, "C:\repo", () => runtime.rpc)()).toEqual({ split: 3 });
  const profiles = JSON.parse(store.getSetting(workspaceId, "lines.profiles")!) as Record<string, { attributes: Array<{ text: string }> }>;
  // The repeated part is offered once; nothing is chosen for a line with no adopted goal.
  expect(profiles["line-empty"]!.attributes.map((item) => item.text)).toEqual(["外推人类知识边界", "以长期研究"]);
  expect(identityLines(store, workspaceId).find((line) => line.id === "line-empty")!.goalParts ?? []).toEqual([]);
  expect(linesAwaitingCandidateSplit(store, workspaceId)).toEqual([]);
});
