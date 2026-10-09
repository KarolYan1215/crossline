import { expect, test } from "vitest";
import { profileGaps, type OnboardingTurn } from "@crossline/core";
import { withChecklist, withGapQuestions } from "./onboarding-session";

const turn = (over: Partial<OnboardingTurn>): OnboardingTurn => ({ reply: "信息已齐。", questions: [], slotUpdates: [], projectsDetected: [], flywheelCandidates: [],
  coverage: [], nextAction: "ready_for_milestones", ...over } as OnboardingTurn);

test("a premature 「ready」 goes back to asking for what the interview still owes; the person's own items do not hold it", () => {
  const held = withChecklist(turn({}), [{ label: "画像每部分都有本人原话或文件为据", detail: "尚无本人依据：能量与心流", owner: "interview" },
    { label: "本人确认画像符合自己", detail: "", owner: "person" }]);
  expect(held.nextAction).toBe("ask");
  expect(held.reply).toContain("完成访谈前还缺：画像每部分都有本人原话或文件为据（尚无本人依据：能量与心流）");
  expect(held.reply).not.toContain("本人确认画像");
  expect(held.questions).toHaveLength(1);
  expect(withChecklist(turn({}), [{ label: "本人确认画像符合自己", detail: "", owner: "person" }]).nextAction).toBe("ready_for_milestones");
});

test("each round gets the app's questions about what it is talking about; with nothing relevant, one other", () => {
  const gaps = profileGaps({ identities: [{ id: "research", label: "研究者" }, { id: "media", label: "创作者" }],
    projects: [{ id: "ece548", identityId: "research", name: "ECE 548" }, { id: "xhs", identityId: "media", name: "小红书" }],
    facts: [{ identityId: "media", projectId: "xhs", slot: "what", value: "图文", status: "confirmed" }, { identityId: "research", projectId: "", slot: "what", value: "博士", status: "confirmed" }],
    unfiled: [{ id: "doc-1", fileName: "Plan.pdf" }], portrait: { written: true, confirmed: false } });
  const ask = (identityId: string, projectId: string) => turn({ nextAction: "ask", questions: [{ id: "q", text: "进展如何？", kind: "free", options: [], allowOther: true, identityId, projectId }] });
  const ids = (output: OnboardingTurn) => output.questions.map((question) => question.id).slice(1);
  // Talking about research: its course's class times, not the file or the portrait.
  expect(ids(withGapQuestions(ask("research", "ece548"), gaps, []))).toEqual(["gap-meetings-ece548"]);
  // The file that came with this reply is asked about with it.
  expect(ids(withGapQuestions(ask("media", "xhs"), gaps, [], { freshDocuments: ["doc-1"] }))).toEqual(["gap-file-doc-1"]);
  // Nothing relevant: one of the rest joins, so nothing waits forever.
  expect(ids(withGapQuestions(ask("media", "xhs"), gaps, []))).toHaveLength(1);
});
