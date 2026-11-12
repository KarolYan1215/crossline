import { expect, test } from "vitest";
import { forgottenTimerStop, planNudges, sessionWorkEnd, sessionWorkedMinutes, type NudgeInput } from "./index";

// The owner's session of 2026-11-11 (America/Chicago): started on the block at 15:37, left running, 结束 (a pause) pressed at 20:58,
// read at 21:24. It was counted to now: 「今天计时 5h47」.
const owners = { startedAt: "2026-11-11T21:37:17.556Z", pauseMinutes: 0, interruptions: [{ pausedAt: "2026-11-12T02:58:48.994Z", reason: "本次计时结束" }] };

test("a session left paused stopped working where the pause began, not now", () => {
  expect(sessionWorkEnd(owners, "2026-11-12T03:24:00.000Z")).toBe(Date.parse("2026-11-12T02:58:48.994Z"));
  expect(sessionWorkedMinutes(owners, "2026-11-12T03:24:00.000Z")).toBe(322);
  // Resumed: counted to now again, less the closed pause.
  const resumed = { ...owners, pauseMinutes: 10, interruptions: [{ ...owners.interruptions[0]!, resumedAt: "2026-11-12T03:08:48.994Z" }] };
  expect(sessionWorkedMinutes(resumed, "2026-11-12T03:24:00.000Z")).toBe(347 - 10);
  // Ended: its end, whatever the last pause.
  expect(sessionWorkEnd({ ...owners, endedAt: "2026-11-12T03:00:00.000Z" }, "2026-11-12T03:24:00.000Z")).toBe(Date.parse("2026-11-12T03:00:00.000Z"));
});

test("a timer nobody stopped is stopped where 「超时」 was due, once it has run three times the usual (at least four hours)", () => {
  const timer = { startedAt: owners.startedAt, usualMinutes: 90 };
  // 90-minute step: forgotten after 270 minutes, stopped at 135.
  expect(forgottenTimerStop(timer, Date.parse(owners.startedAt) + 269 * 60_000)).toBeUndefined();
  expect(forgottenTimerStop(timer, Date.parse(owners.startedAt) + 270 * 60_000)).toBe(new Date(Date.parse(owners.startedAt) + 135 * 60_000).toISOString());
  // A short step still runs four hours before it is called forgotten.
  expect(forgottenTimerStop({ ...timer, usualMinutes: 20 }, Date.parse(owners.startedAt) + 239 * 60_000)).toBeUndefined();
  expect(forgottenTimerStop({ ...timer, usualMinutes: 20 }, Date.parse(owners.startedAt) + 240 * 60_000)).toBeDefined();
  // Paused, or with no usual length: left alone.
  expect(forgottenTimerStop({ ...timer, paused: true }, Date.parse(owners.startedAt) + 600 * 60_000)).toBeUndefined();
  expect(forgottenTimerStop({ ...timer, usualMinutes: 0 }, Date.parse(owners.startedAt) + 600 * 60_000)).toBeUndefined();
});

test("「超时」 is said even when the day's cap is spent, and offers to stop the timer at the usual length", () => {
  // 15:37 start, 90-minute step, 17:52 local now; six counted messages already said today.
  const input: NudgeInput = {
    now: "2026-11-11T23:52:30.000Z", today: "2026-11-11", clock: "17:52", tomorrow: "2026-11-12", level: "normal",
    quiet: { timerRunning: true, inMeeting: false, answeredRecently: false }, muted: new Set(), sent: new Set(), countedToday: 6,
    blocks: [], ending: [], slack: [], finished: [],
    timer: { orderId: "neurosim", title: "完成西湖 NeuroSim 仿真", stepId: "v6s2", stepTitle: "批准实测参数映射", startedAt: owners.startedAt, usualMinutes: 90 }
  };
  const [nudge] = planNudges(input);
  expect(nudge).toMatchObject({ kind: "timer_overrun", counted: false, urgent: true });
  const stop = nudge!.buttons.find((button) => button.label.startsWith("早停了"));
  expect(stop).toMatchObject({ kind: "action", label: "早停了：算到 17:07", action: { action: "task.op", args: { workOrderId: "neurosim", type: "stop_timer", minutes: 90 } } });
});
