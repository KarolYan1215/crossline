import { expect, test } from "vitest";
import type { OnboardingTurn } from "@crossline/core";
import { withChecklist } from "./onboarding-session";

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
