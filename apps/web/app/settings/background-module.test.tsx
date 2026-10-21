import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { BackgroundModule, when } from "./background-module";

const overview = {
  timeZone: "America/Chicago",
  engagement: { tier: "cooling" as const, lastActiveAt: "2026-10-10T07:49:00.000Z" },
  kinds: [
    { kind: "tutorials" as const, label: "任务教程", explained: "为 48 小时内要做的任务查资料、写教程", paused: false, lastRunAt: "2026-10-12T19:07:16.000Z", lastOk: true, weekRuns: 25, weekTokens: 7_140_000, weekCacheShare: 0.47 },
    { kind: "assistant" as const, label: "助手代办", explained: "助手代为完成准备类杂事", paused: true, lastRunAt: null, lastOk: null, weekRuns: 0, weekTokens: 0, weekCacheShare: null }
  ],
  running: [{ taskId: "t1", title: "ECE 548 · 汇集复习材料", startedAt: "2026-10-13T09:00:00.000Z" }]
};

test("each kind shows its last run, its week and a pause; the tier says what runs now; a running task can be stopped", () => {
  const html = renderToStaticMarkup(<BackgroundModule overview={overview} />);
  expect(html).toContain("只做收集分析与日历归类");
  // Shown on the person's clock (Chicago), not UTC.
  expect(html).toContain("最近一次本人操作 10/10 02:49");
  expect(html).toContain("上次 10/12 14:07 · 近 7 天 25 次、714 万 tokens（输入的 47% 来自缓存）");
  expect(html.match(/role="radiogroup"/g)).toHaveLength(2);
  expect(html).toContain("ECE 548 · 汇集复习材料");
  expect(html).toContain("中止");
});

test("with nothing running it says so", () => {
  expect(renderToStaticMarkup(<BackgroundModule overview={{ ...overview, running: [] }} />)).toContain("现在没有正在运行的助手任务");
});

test("a time past midnight in UTC is still the evening before on the person's clock", () => {
  expect(when("2026-10-14T03:46:00.000Z", "America/Chicago")).toBe("10/13 22:46");
  expect(when(null, "America/Chicago")).toBe("—");
});
