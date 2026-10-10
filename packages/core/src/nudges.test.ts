import { expect, test } from "vitest";
import { nudgeCandidates, planNudges, type NudgeInput } from "./index";

const base = (over: Partial<NudgeInput> = {}): NudgeInput => ({
  now: "2026-10-10T19:50:00.000Z", today: "2026-10-10", clock: "14:50", tomorrow: "2026-10-11", level: "normal",
  quiet: { timerRunning: false, inMeeting: false, answeredRecently: false }, muted: new Set(), sent: new Set(), countedToday: 0,
  blocks: [{ id: "scheduled:hw2:v1s1", orderId: "hw2", stepId: "v1s1", title: "完成 ECE 555 作业 2", step: "拆解题目", start: "15:00", end: "15:30", dueDay: "2026-10-12", lastStartedAt: "" }],
  slack: [], finished: [], ...over
});

test("fifteen minutes before a block that bears on a deadline, it says so with 开始计时 and 推到明天; not counted against the cap", () => {
  const [nudge] = planNudges(base());
  expect(nudge).toMatchObject({ kind: "block_start", urgent: true, counted: false, fingerprint: "start:scheduled:hw2:v1s1:2026-10-10" });
  expect(nudge!.text).toContain("关系到 10/12 的截止");
  expect(nudge!.buttons.map((button) => button.label)).toEqual(["开始计时", "推到明天", "少问这类"]);
  expect(planNudges(base({ clock: "14:40" }))).toEqual([]);
  expect(planNudges(base({ sent: new Set(["start:scheduled:hw2:v1s1:2026-10-10"]) }))).toEqual([]);
});

test("a block that ended unstarted is offered a remedy; one whose task began during it is not", () => {
  expect(planNudges(base({ clock: "15:40", now: "2026-10-10T20:40:00.000Z" }))[0]).toMatchObject({ kind: "block_missed", urgent: true });
  const started = base({ clock: "15:40", blocks: [{ ...base().blocks[0]!, lastStartedAt: "2026-10-10T15:05:00" }] });
  expect(planNudges(started)).toEqual([]);
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
  expect(nudge).toMatchObject({ kind: "timer_overrun" });
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
