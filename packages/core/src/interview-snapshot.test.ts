import { expect, test } from "vitest";
import { interviewChecklist, renderInterviewSnapshot, SNAPSHOT_ANSWERS_SHOWN, type ChecklistInput, type SnapshotQuestion } from "./index";

const input: ChecklistInput = {
  lines: [{ id: "design", label: "设计师", hard: true, goals: [] }], descriptions: {}, profile: {}, facts: [],
  projects: [{ id: "brand", identityId: "design", name: "品牌稿" }], dates: [], availability: false, unfiledFiles: 0, portraitConfirmed: false,
  verdicts: { "hard_schedule:design": { id: "hard_schedule:design", status: "partial", basis: [{ ref: "reply-3", quote: "周二下午固定开会" }], note: "其余几天还没说" } }
};
const question = (id: number, over: Partial<SnapshotQuestion> = {}): SnapshotQuestion => ({ id, kind: "interview", key: `iq:s:${id}:main-1`, text: `问题 ${id}`,
  options: [], identityId: "", projectId: "", status: "answered", answer: `回答 ${id}`, answerSentences: [], askedAt: "2026-11-25T10:00:00Z", ...over });

// 2026-11-25 (「访谈账本驱动」): the model judges against what the ledger says now, not against a thread that may have been compacted.
test("the snapshot lists each judged item with the model's last verdict, every asked question by its meaning, and the days the person gave", () => {
  const snapshot = renderInterviewSnapshot({ round: 5, items: interviewChecklist(input),
    questions: [question(1, { gist: "接单挤占更新的一次经过", text: "最近一次接单影响更新时发生了什么？", answer: "想不起来" }),
      question(2, { status: "open", answer: "", gist: "" }), question(3, { key: "gap:gap-deadline-brand", status: "pending", answer: "" }),
      question(4, { status: "dropped" })],
    datesSaid: [{ ref: "reply-3", dates: ["12月5日"] }, { ref: "reply-5", dates: [] }] });
  expect(snapshot.startsWith("〔账本快照 · 第 5 轮开始前")).toBe(true);
  expect(snapshot).toContain("- hard_schedule:design｜「设计师」的每周固定安排已收集｜partial ← reply-3「周二下午固定开会」（其余几天还没说）");
  expect(snapshot).toContain("- line_desc:design｜「设计师」有个性化描述与长期目标候选｜未判｜缺：尚无描述");
  expect(snapshot).toContain("- project:brand｜「品牌稿」目标、截止与进展证据（可留到排任务时再问）｜未判");
  expect(snapshot).toContain("- #1 已答｜接单挤占更新的一次经过｜原题：最近一次接单影响更新时发生了什么？ → 「想不起来」");
  expect(snapshot).toContain("- #2 未答｜问题 2");
  expect(snapshot).toContain("- #3 待问｜问题 3（应用的待问题，用 ask_app_question 问）");
  expect(snapshot).not.toContain("#4 ");
  expect(snapshot).toContain("- reply-3：12月5日");
  expect(snapshot).not.toContain("reply-5：");
  expect(snapshot).not.toContain("四、");
});

test("older answered questions stay listed by their meaning alone; the disclosure's note is the last part", () => {
  const many = Array.from({ length: SNAPSHOT_ANSWERS_SHOWN + 2 }, (_, index) => question(index + 1, { gist: `意思 ${index + 1}` }));
  const snapshot = renderInterviewSnapshot({ round: 40, items: [], questions: many, datesSaid: [], disclosure: "本人在 reply-7 谈到过一段艰难时期，原文已换成占位，不给你看。" });
  expect(snapshot).toContain("- #1 已答｜意思 1｜原题：问题 1\n");
  expect(snapshot).toContain(`- #${many.length} 已答｜意思 ${many.length}｜原题：问题 ${many.length} → 「回答 ${many.length}」`);
  expect(snapshot).toContain("- （本人还没写过具体日期）");
  expect(snapshot.trim().endsWith("四、本人在 reply-7 谈到过一段艰难时期，原文已换成占位，不给你看。")).toBe(true);
});
