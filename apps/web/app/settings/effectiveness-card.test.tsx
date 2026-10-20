import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { attentionSummary, computeEffectiveness } from "@crossline/core";
import { EffectivenessCard } from "./effectiveness-card";

const data = computeEffectiveness({ today: "2026-10-20", milestones: [], durations: [], minutesByLine: {}, deadlineMinutes: 0, totalMinutes: 0, priorityOrder: [],
  decisions: { count: 0, minutes: 0 }, captureToScheduledMinutes: [], pendingNow: 0, committedOrders: 0, committedWithBlock: 0, liveMilestones: 0,
  milestonesWithProgressLast7d: 0, waitingAnswered: 0, waitingAnsweredOnTime: 0 });

test("系统体检 shows the interview's attention time against its targets, and nothing about it before the interview recorded any", () => {
  const setup = attentionSummary({ seconds: 3_000, lastBeatAt: "2026-10-12T10:00:00.000Z", ready: { seconds: 2_100, rounds: 6, at: "2026-10-12T10:00:00.000Z" } })!;
  const html = renderToStaticMarkup(<EffectivenessCard data={{ ...data, setup }} labels={{}} />);
  expect(html).toContain("访谈用时 50 分");
  expect(html).toContain("35 分");
  expect(html).toContain("第 6 轮可开始");
  expect(html).toContain("超出目标");
  expect(renderToStaticMarkup(<EffectivenessCard data={data} labels={{}} />)).not.toContain("访谈用时");
});
