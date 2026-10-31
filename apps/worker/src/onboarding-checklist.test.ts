import { expect, test } from "vitest";
import { profileGaps, type OnboardingTurn } from "@crossline/core";
import { stagePace, withChecklist, withGapQuestions } from "./onboarding-session";

const turn = (over: Partial<OnboardingTurn>): OnboardingTurn => ({ reply: "信息已齐。", questions: [], slotUpdates: [], projectsDetected: [], flywheelCandidates: [],
  coverage: [], nextAction: "ready_for_milestones", ...over } as OnboardingTurn);

test("a premature 「ready」 goes back to asking for what the interview still owes; the person's own items do not hold it", () => {
  const held = withChecklist(turn({}), [{ label: "画像每部分都有本人原话或文件为据", detail: "尚无本人依据：能量与心流", owner: "interview",
    ask: "最近一次做得忘了时间，是在做什么？" }, { label: "本人确认画像符合自己", detail: "", owner: "person" }]);
  expect(held.nextAction).toBe("ask");
  // The person is asked the item's question; the checklist's own words never reach the reply.
  expect(held.reply).not.toContain("画像每部分");
  expect(held.reply).not.toContain("本人确认画像");
  expect(held.questions.map((question) => question.text)).toEqual(["最近一次做得忘了时间，是在做什么？"]);
  // An item with no question of its own still holds the end, with the stage's open question.
  expect(withChecklist(turn({ stage: "energy" }), [{ label: "画像字段", detail: "", owner: "interview" }]).questions).toHaveLength(1);
  expect(withChecklist(turn({}), [{ label: "本人确认画像符合自己", detail: "", owner: "person" }]).nextAction).toBe("ready_for_milestones");
});

test("each round gets the app's questions about what it is talking about; with nothing relevant, one other", () => {
  const gaps = profileGaps({ identities: [{ id: "research", label: "研究者" }, { id: "media", label: "创作者" }],
    projects: [{ id: "ece548", identityId: "research", name: "ECE 548" }, { id: "xhs", identityId: "media", name: "小红书" }],
    facts: [{ identityId: "media", projectId: "xhs", slot: "what", value: "图文", status: "confirmed" }, { identityId: "research", projectId: "", slot: "what", value: "博士", status: "confirmed" }],
    dated: ["ece548", "xhs"], unfiled: [{ id: "doc-1", fileName: "Plan.pdf" }], portrait: { written: true, confirmed: false } });
  const ask = (identityId: string, projectId: string) => turn({ nextAction: "ask", questions: [{ id: "q", text: "进展如何？", kind: "free", options: [], allowOther: true, identityId, projectId }] });
  const ids = (output: OnboardingTurn) => output.questions.map((question) => question.id).slice(1);
  // Talking about research: its course's class times, not the file or the portrait.
  expect(ids(withGapQuestions(ask("research", "ece548"), gaps, []))).toEqual(["gap-meetings-ece548"]);
  // The file that came with this reply is asked about with it.
  expect(ids(withGapQuestions(ask("media", "xhs"), gaps, [], { freshDocuments: ["doc-1"] }))).toEqual(["gap-file-doc-1"]);
  // Nothing relevant: one of the rest joins, so nothing waits forever.
  expect(ids(withGapQuestions(ask("media", "xhs"), gaps, []))).toHaveLength(1);
});

test("同一阶段第二轮起才换阶段；五条没齐时前段不换阶段", () => {
  const round = (stage: string) => ({ role: "assistant", content: { stage } });
  expect(stagePace([round("compass"), { role: "user", content: {} }, round("energy")], { startOpen: false })).toEqual({ stageRounds: 1 });
  const stuckFront = stagePace([round("lines"), { role: "user", content: {} }, round("lines")], { startOpen: true });
  expect(stuckFront).toEqual({ stageRounds: 2 });
  const stuckBack = stagePace([round("energy"), { role: "user", content: {} }, round("energy")], { startOpen: true });
  expect(stuckBack.moveOn).toContain("进入下一阶段");
  expect(stuckBack.moveOn).not.toContain("假设");
  // With the start items in, the front stages move on like the rest.
  expect(stagePace([round("lines"), { role: "user", content: {} }, round("lines")], { startOpen: false }).moveOn).toContain("进入下一阶段");
});

test("a round that still asks always has something to answer: the app's waiting questions, else one open question for the stage", async () => {
  const { withSomethingToAnswer } = await import("./onboarding-session");
  const empty = turn({ nextAction: "ask", stage: "situation" });
  const gaps = profileGaps({ identities: [{ id: "research", label: "研究者" }], projects: [{ id: "ece548", identityId: "research", name: "ECE 548" }],
    facts: [], dated: ["ece548"], unfiled: [], portrait: { written: false, confirmed: false } });
  expect(withSomethingToAnswer(empty, gaps, []).questions.map((question) => question.id)).toContain("gap-meetings-ece548");
  const open = withSomethingToAnswer(empty, [], []);
  expect(open.questions).toEqual([expect.objectContaining({ id: "open-situation", kind: "free" })]);
  // A round with questions, or one that is finished, is left alone.
  expect(withSomethingToAnswer(turn({}), [], []).questions).toEqual([]);
});
