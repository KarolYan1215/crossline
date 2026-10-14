import { expect, test } from "vitest";
import { nudgeCandidates, planNudges, type NudgeInput } from "./index";

const base = (over: Partial<NudgeInput> = {}): NudgeInput => ({
  now: "2026-10-10T19:50:00.000Z", today: "2026-10-10", clock: "14:50", tomorrow: "2026-10-11", level: "normal",
  quiet: { timerRunning: false, inMeeting: false, answeredRecently: false }, muted: new Set(), sent: new Set(), countedToday: 0,
  blocks: [{ id: "scheduled:hw2:v1s1", orderId: "hw2", stepId: "v1s1", title: "完成 ECE 555 作业 2", step: "拆解题目", start: "15:00", end: "15:30", dueDay: "2026-10-12" }],
  ending: [], slack: [], finished: [], ...over
});

test("fifteen minutes before a block that bears on a deadline, it says so with 开始计时 and 推到明天; not counted against the cap", () => {
  const [nudge] = planNudges(base());
  expect(nudge).toMatchObject({ kind: "block_start", urgent: true, counted: false, fingerprint: "start:scheduled:hw2:v1s1:2026-10-10" });
  expect(nudge!.text).toContain("关系到 10/12 的截止");
  expect(nudge!.buttons.map((button) => button.label)).toEqual(["开始计时", "推到明天", "少问这类"]);
  expect(nudge!.text).not.toContain("第一步");
  // The step's first move, when the plan has one, is said with it so the block is easy to begin.
  expect(planNudges(base({ blocks: [{ ...base().blocks[0]!, firstAction: "打开作业 PDF，抄下第 1 题" }] }))[0]!.text).toContain("第一步：打开作业 PDF，抄下第 1 题。");
  expect(planNudges(base({ clock: "14:40" }))).toEqual([]);
  expect(planNudges(base({ sent: new Set(["start:scheduled:hw2:v1s1:2026-10-10"]) }))).toEqual([]);
});

test("every block of the day is asked about once within half an hour of its end, with a button that opens the confirm page", () => {
  const ending = [{ id: "scheduled:read:v2s1", orderId: "read", stepId: "v2s1", title: "读 ECE 548 第 5 讲", step: "", day: "2026-10-10", start: "15:00", end: "15:30", endedTimerAt: "" }];
  const [nudge] = planNudges(base({ blocks: [], ending, clock: "15:40", now: "2026-10-10T20:40:00.000Z" }));
  expect(nudge).toMatchObject({ kind: "block_confirm", urgent: true, counted: true, fingerprint: "confirm:scheduled:read:v2s1:2026-10-10", block: ending[0] });
  expect(nudge!.buttons[0]).toEqual({ kind: "href", label: "确认", href: "/confirm/{message}" });
  expect(planNudges(base({ blocks: [], ending, clock: "15:29" }))).toEqual([]);
  expect(planNudges(base({ blocks: [], ending, clock: "16:00" }))).toEqual([]);
});

test("no question for a block whose timer the person already stopped, one whose timer still runs, or at night", () => {
  const block = { id: "scheduled:read:v2s1", orderId: "read", stepId: "v2s1", title: "读 ECE 548 第 5 讲", step: "", day: "2026-10-10", start: "15:00", end: "15:30", endedTimerAt: "" };
  expect(planNudges(base({ blocks: [], ending: [{ ...block, endedTimerAt: "15:25" }], clock: "15:40" }))).toEqual([]);
  const timer = { orderId: "read", title: "读", stepId: "v2s1", stepTitle: "", startedAt: "2026-10-10T20:00:00.000Z", usualMinutes: 300 };
  expect(planNudges(base({ blocks: [], ending: [block], clock: "15:40", timer })).map((item) => item.kind)).not.toContain("block_confirm");
  const late = { ...block, start: "23:00", end: "23:30" };
  expect(planNudges(base({ blocks: [], ending: [late], clock: "23:40", night: true }))).toEqual([]);
});

test("too little time before a due day: tight below a day's worth of free time, late below zero (and late is urgent)", () => {
  const tight = planNudges(base({ blocks: [], slack: [{ orderId: "o", title: "ECE 548 复习", dueDay: "2026-10-27", remainingMinutes: 600, freeMinutes: 800, dailyMinutes: 420 }] }));
  expect(tight[0]).toMatchObject({ kind: "latest_start", urgent: false, fingerprint: "latest:o:2026-10-27:tight" });
  const late = planNudges(base({ blocks: [], slack: [{ orderId: "o", title: "ECE 548 复习", dueDay: "2026-10-27", remainingMinutes: 900, freeMinutes: 800, dailyMinutes: 420 }] }));
  expect(late[0]).toMatchObject({ urgent: true, fingerprint: "latest:o:2026-10-27:late" });
  expect(late[0]!.text).toContain("来不及");
  expect(planNudges(base({ blocks: [], slack: [{ orderId: "o", title: "x", dueDay: "2026-10-27", remainingMinutes: 60, freeMinutes: 800, dailyMinutes: 420 }] }))).toEqual([]);
});

test("a timer half again over the step's usual minutes asks whether the step is done", () => {
  const timer = { orderId: "hw2", title: "完成 ECE 555 作业 2", stepId: "v1s1", stepTitle: "拆解题目", startedAt: "2026-10-10T19:00:00.000Z", usualMinutes: 30 };
  const [nudge] = planNudges(base({ blocks: [], timer, quiet: { timerRunning: true, inMeeting: false, answeredRecently: false } }));
  expect(nudge).toMatchObject({ kind: "timer_overrun", step: { orderId: "hw2", stepId: "v1s1" } });
  expect(nudge!.buttons[0]).toMatchObject({ kind: "action", label: "这步做完了", action: { args: { type: "step_done", stepId: "v1s1" } } });
  expect(planNudges(base({ blocks: [], timer: { ...timer, startedAt: "2026-10-10T19:30:00.000Z" } }))).toEqual([]);
});

test("busy, muted, capped: only the urgent get through while busy, a muted kind never, and the counted stop at the day's cap", () => {
  const finished = [{ key: "agent:a", text: "助手做完了「索引」", label: "去审阅", href: "/approvals#assistant" }];
  expect(planNudges(base({ blocks: [], finished, quiet: { timerRunning: false, inMeeting: true, answeredRecently: false } }))).toEqual([]);
  expect(planNudges(base({ blocks: [], finished }))).toHaveLength(1);
  expect(planNudges(base({ muted: new Set(["block_start"]) }))).toEqual([]);
  expect(planNudges(base({ blocks: [], finished, countedToday: 6 }))).toEqual([]);
  // The block's start is not counted: it is said even with the cap reached.
  expect(planNudges(base({ countedToday: 6 }))).toHaveLength(1);
  expect(planNudges(base({ level: "off" }))).toEqual([]);
  expect(nudgeCandidates(base({ level: "off" }))).toHaveLength(1);
});

test("background work finished together is one message, and at night only what follows the person's own activity is said", () => {
  const finished = [{ key: "agent:a", text: "助手做完了「索引」", label: "去审阅", href: "/approvals#assistant" },
    { key: "agent:b", text: "「题单」已备好", label: "打开任务", href: "/workbench/x" }];
  const [batched] = planNudges(base({ blocks: [], finished }));
  expect(batched).toMatchObject({ fingerprint: "done:agent:a", covers: ["done:agent:b"] });
  expect(batched!.text).toContain("后台完成了 2 件");
  expect(planNudges(base({ blocks: [], finished, sent: new Set(["done:agent:a", "done:agent:b"]) }))).toEqual([]);
  expect(planNudges(base({ blocks: [], finished, night: true }))).toEqual([]);
  expect(planNudges(base({ night: true })).map((item) => item.kind)).toEqual(["block_start"]);
});

test("when a block comes up, what the assistant has ready for it is named", () => {
  const [nudge] = planNudges(base({ blocks: [{ ...base().blocks[0]!, prepared: ["公式表.md", "样题清单.md"] }] }));
  expect(nudge!.text).toContain("已备好：公式表.md、样题清单.md。");
});
