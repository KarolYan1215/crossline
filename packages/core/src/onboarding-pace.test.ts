import { describe, expect, it } from "vitest";
import { capacityConflict, timelineDeadlines, checkInsight, fixedScheduleLines, interviewAbstract, lineWeights, plainTerms, portraitConfirmedByInsights, progressLines, progressView, readTurnProgress, skeletonDraft, withPlainTerms } from "./onboarding-pace";
import { DEADLINE_GUESS_PREFIX, answeredGapFacts, profileGaps } from "./profile-gaps";
import { interviewChecklist, interviewComplete, interviewOwnedOpen } from "./interview-checklist";

const replies = { "reply-2": "最投入的两次都是和同学一起赶比赛项目，熬夜也不累。", "reply-6": "底座是我一个人做的研究，常常一整天不说话。" };

describe("观察卡", () => {
  const falsifier = "如果一个人赶的项目也让你同样投入，这条就不准";
  it("有证伪条件、每段引文都在所引回答里时保留；一条回答也可以", () => {
    const kept = checkInsight({ text: "有人等着结果的事更容易让你投入。", falsifier,
      refs: [{ replyId: "reply-2", quote: "和同学一起赶比赛项目" }, { replyId: "reply-6", quote: "一个人做的研究" }] }, replies, "energy");
    expect(kept?.refs).toHaveLength(2);
    expect(kept?.falsifier).toBe(falsifier);
    expect(checkInsight({ text: "x", falsifier, refs: [{ replyId: "reply-2", quote: "熬夜也不累" }] }, replies, "lines")?.refs).toHaveLength(1);
  });
  it("引文不在原文、没有证伪条件、没有引文、空文本或在单条主线访谈里时丢掉", () => {
    const refs = [{ replyId: "reply-2", quote: "和同学一起赶比赛项目" }, { replyId: "reply-6", quote: "一个人做的实验" }];
    expect(checkInsight({ text: "x", falsifier, refs }, replies, "energy")).toBeUndefined();
    expect(checkInsight({ text: "x", falsifier: " ", refs: [refs[0]!] }, replies, "energy")).toBeUndefined();
    expect(checkInsight({ text: "x", falsifier, refs: [] }, replies, "energy")).toBeUndefined();
    expect(checkInsight({ text: "x", falsifier, refs: [refs[0]!] }, replies, "details")).toBeUndefined();
    expect(checkInsight({ text: "", falsifier, refs: [] }, replies, "compass")).toBeUndefined();
  });
  it("外部数据只留带网址的", () => {
    const kept = checkInsight({ text: "x", falsifier, refs: [{ replyId: "reply-2", quote: "熬夜也不累" }],
      external: [{ text: "内隐与外显动机相关 r = .13", url: "https://www.frontiersin.org/articles/10.3389/fpsyg.2014.00826/full" }, { text: "没有出处", url: "某论文" }] }, replies, "compass");
    expect(kept?.external).toEqual([{ text: "内隐与外显动机相关 r = .13", url: "https://www.frontiersin.org/articles/10.3389/fpsyg.2014.00826/full" }]);
  });
  it("三个深度阶段各有一条「准」才算确认画像", () => {
    const at = "2026-10-19T00:00:00Z";
    expect(portraitConfirmedByInsights({ a: { verdict: "fits", stage: "situation", at }, b: { verdict: "fits", stage: "compass", at } })).toBe(false);
    expect(portraitConfirmedByInsights({ a: { verdict: "fits", stage: "situation", at }, b: { verdict: "fits", stage: "compass", at },
      c: { verdict: "off", stage: "energy", at } })).toBe(false);
    expect(portraitConfirmedByInsights({ a: { verdict: "fits", stage: "situation", at }, b: { verdict: "fits", stage: "compass", at },
      c: { verdict: "fits", stage: "energy", at } })).toBe(true);
  });
});

describe("进度账", () => {
  it("读回模型的进度记录并给出下一轮的几行", () => {
    const progress = readTurnProgress({ part: "situation", covered: ["最想推进的事"], open: ["三个月不变先出问题的事"], partDone: false, next: "问三个月" });
    expect(progress?.part).toBe("situation");
    expect(progressLines(progress)[0]).toContain("第 3/5 部分「处境」未完成");
    expect(progressView(progress, "situation")).toMatchObject({ index: 3, total: 5, clear: 1, of: 2 });
    expect(readTurnProgress({ part: "nope" })).toBeUndefined();
    expect(progressView(undefined, "details").index).toBe(5);
  });
  it("最远到过的部分记下来：回到前面的部分补问一题，不算重新开始（W-235）", () => {
    expect(progressView(undefined, "compass", "v2", "quick", ["narrative", "compass", "lines", "compass"])).toMatchObject({ index: 2, total: 6, reached: 6 });
    expect(progressView(undefined, "compass", "v2", "quick", ["narrative", "", "nope"])).toMatchObject({ index: 2, reached: 2 });
  });
  it("部分编号只有一个来源：按本轮的阶段数，模型进度记录说的是别的部分时不算（W-186）", () => {
    // The round is in the compass part; the model's own record still names the lines part, the sixth of six in the newer order.
    const stale = readTurnProgress({ part: "lines", covered: ["a", "b", "c", "d", "e", "f"], open: [], partDone: true, next: "" });
    expect(progressView(stale, "compass", "v2")).toMatchObject({ index: 2, total: 6, label: "指南针", clear: 0, of: 0 });
    // The same part: its record counts.
    const own = readTurnProgress({ part: "compass", covered: ["工作观"], open: ["人生观"], partDone: false, next: "" });
    expect(progressView(own, "compass", "v2")).toMatchObject({ index: 2, total: 6, clear: 1, of: 2 });
    // No tier adds a details part any more (2026-11-12): six, whatever depth an account once stored.
    expect(progressView(undefined, "narrative", "v2", "thorough")).toMatchObject({ index: 1, total: 6 });
  });
  it("摘要不超过十五行", () => {
    const lines = Array.from({ length: 6 }, (_, index) => ({ id: `l${index}`, label: `线${index}`, description: "描述", goal: "" }));
    const abstract = interviewAbstract({ lines, projects: [], weeklyHours: { hours: 40, source: "访谈提议" }, fixedCount: 3,
      profile: { problem: "论文和创业抢时间" }, filesRead: 2, recent: Array.from({ length: 10 }, (_, index) => `事实 ${index}`) });
    expect(abstract.length).toBeLessThanOrEqual(15);
    expect(abstract.join("\n")).toContain("每周可用约 40 小时");
  });
  it("固定日程每次见面各占一行，带自己的星期和时间（W-183）", () => {
    // Tuesday afternoon and Thursday morning of one course, and a course meeting Monday and Wednesday at the same time.
    const lines = fixedScheduleLines([
      { title: "ECE 548", weekdays: [4], startTime: "09:00", endTime: "11:30" },
      { title: "ECE 548", weekdays: [2], startTime: "14:00", endTime: "16:30" },
      { title: "组会", weekdays: [3, 1], startTime: "10:00", endTime: "11:00" },
      { title: "周日练琴", weekdays: [0], startTime: "19:00", endTime: "20:00" }
    ]);
    expect(lines).toEqual(["周一 10:00–11:00 组会", "周二 14:00–16:30 ECE 548", "周三 10:00–11:00 组会", "周四 09:00–11:30 ECE 548", "周日 19:00–20:00 周日练琴"]);
    expect(fixedScheduleLines([])).toEqual([]);
  });
});

describe("容量与骨架", () => {
  const windows = [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", energy: "high" as const }];
  const busy = [{ weekday: 1, start: "10:00", end: "12:00" }, { weekday: 3, start: "10:00", end: "12:00" }];
  it("算出可用、固定、剩余和挤在一起的截止", () => {
    const reading = capacityConflict({ windows, busy, today: "2026-10-19", lines: [{ id: "a", label: "研究", weight: 2 }, { id: "b", label: "创业", weight: 1 }],
      deadlines: [{ date: "2026-10-28", title: "作业 3" }, { date: "2026-10-29", title: "期中" }, { date: "2026-12-30", title: "太远" }] });
    expect(reading).toMatchObject({ available: 40, fixed: 4, free: 36, deadlines: 2 });
    expect(reading.crunches[0]).toMatchObject({ from: "2026-10-28", to: "2026-10-29" });
    expect(reading.perLine).toEqual([{ lineId: "a", label: "研究", hours: 24 }, { lineId: "b", label: "创业", hours: 12 }]);
    expect(reading.notes.join("")).toContain("挤在一起");
  });
  it("骨架草稿按权重分空闲时间，不压在固定安排上", () => {
    const draft = skeletonDraft(windows, busy, lineWeights([{ id: "a", rank: 1 }, { id: "b", rank: null }], null));
    const hours = (id: string) => draft.filter((block) => block.lineId === id).reduce((sum, block) => {
      const [sh, sm] = block.start.split(":").map(Number), [eh, em] = block.end.split(":").map(Number);
      return sum + (eh! * 60 + em! - sh! * 60 - sm!) / 60;
    }, 0);
    expect(hours("a") + hours("b")).toBe(36);
    expect(Math.abs(hours("a") - 24)).toBeLessThanOrEqual(1);
    expect(draft.some((block) => block.weekday === 1 && block.start < "12:00" && block.end > "10:00")).toBe(false);
  });
});

describe("截止日期只问要紧的", () => {
  const projects = [{ id: "p1", identityId: "research", name: "论文" }, { id: "p2", identityId: "research", name: "综述" }];
  const base = { identities: [{ id: "research", label: "研究者" }], projects, documents: [], undated: [] } as unknown as Parameters<typeof profileGaps>[0];
  it("同一条线已有项目知道截止时，其他项目的截止不阻塞", () => {
    const gaps = profileGaps({ ...base, facts: [{ identityId: "research", projectId: "p1", slot: "deadline", value: "12 月中", status: "confirmed" }] })
      .filter((gap) => gap.code === "PROJECT_DEADLINE");
    expect(gaps.map((gap) => [gap.projectId, gap.blocking])).toEqual([["p2", false]]);
  });
  it("推断的截止可以一键采用", () => {
    const gaps = profileGaps({ ...base, facts: [{ identityId: "research", projectId: "p1", slot: "deadline", value: "推断：2026-12-11（期末周前一周）", status: "inferred" }] });
    const gap = gaps.find((item) => item.projectId === "p1")!;
    expect(gap.blocking).toBe(true);
    const label = gap.question.options[0]!.label;
    expect(label.startsWith(DEADLINE_GUESS_PREFIX)).toBe(true);
    const facts = answeredGapFacts(`【${gap.question.text}】选择：${label}`, gaps);
    expect(facts[0]).toMatchObject({ slot: "deadline", value: "2026-12-11（期末周前一周）", projectId: "p1" });
  });
});

describe("项目细节不再拖住访谈", () => {
  it("项目的目标与证据项是延后项，不算未完成", () => {
    const items = interviewChecklist({ lines: [], descriptions: {}, profile: {}, facts: [], projects: [{ id: "p1", identityId: "research", name: "论文" }],
      dates: [], availability: true, unfiledFiles: 0, portraitConfirmed: true });
    const project = items.find((item) => item.id === "project:p1")!;
    expect(project.deferred).toBe(true);
    expect(interviewOwnedOpen(items).some((item) => item.id === "project:p1")).toBe(false);
    expect(interviewComplete(items.filter((item) => !item.id.startsWith("portrait")))).toBe(true);
  });
});

describe("the app's own terms", () => {
  it("are put into everyday words wherever the interview speaks to the person", () => {
    expect(plainTerms("「上班」是硬约束；左栏已有 3 个候选定语。")).toBe("「上班」是固定安排；左栏已有 3 个候选词。");
    const round = withPlainTerms({ reply: "定语选好了吗？", questions: [{ id: "q", text: "哪些定语合适？", kind: "multi" as const, allowOther: true,
      identityId: "", projectId: "", options: [{ id: "a", label: "硬约束", detail: "定语" }] }] });
    expect(round.reply).toBe("形容词选好了吗？");
    expect(round.questions[0]!.options[0]).toEqual({ id: "a", label: "固定安排", detail: "形容词" });
  });
  // 2026-10-31 walkthrough C: an option with no detail ended the interview with 「Cannot read properties of undefined (reading 'replace')」.
  it("leave out what a round left out", () => {
    const options = [{ id: "a", label: "硬约束" }] as unknown as Array<{ id: string; label: string; detail: string }>;
    const round = withPlainTerms({ reply: "好", questions: [{ id: "q", text: "选一个", kind: "single" as const, allowOther: true, identityId: "", projectId: "", options }] });
    expect(round.questions[0]!.options[0]).toEqual({ id: "a", label: "固定安排", detail: undefined });
  });
});
it("counts a project's deadline once when one of its items falls on it, and names what a course's deadline is (W-240)", () => {
  const deadlines = timelineDeadlines([
    { name: "MoS₂ 存内计算研究", deadline: "2026-12-01（第一阶段器件仿真交导师查看）", items: [{ date: "2026-12-01", title: "MoS₂ 存内计算第一阶段器件仿真提交导师" }] },
    { name: "ECE 555", deadline: "2026-11-21 23:59（作业 5）", items: [{ date: "2026-12-05", title: "作业 6 截止" }] },
    { name: "ECE 548", deadline: "待定", items: [{ date: "2026-11-20", title: "ECE 548 期中考试" }] }
  ]);
  expect(deadlines).toEqual([
    { date: "2026-12-01", title: "MoS₂ 存内计算第一阶段器件仿真提交导师" },
    { date: "2026-12-05", title: "ECE 555 作业 6 截止" },
    { date: "2026-11-21", title: "ECE 555 作业 5" },
    { date: "2026-11-20", title: "ECE 548 期中考试" }
  ]);
});
