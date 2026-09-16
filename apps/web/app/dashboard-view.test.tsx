import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { DashboardView, type DashboardData } from "./dashboard-view";

describe("dashboard view", () => {
  test("renders one next action, two alternatives, and all identity lanes", () => {
    const html = renderToStaticMarkup(<DashboardView data={{
      nowLabel: "周一 · 09:00", nowIso: "2026-09-14T14:00:00.000Z", timeZone: "America/Chicago", clockPinned: true,
      dateLabel: "14",
      monthLabel: "SEP · 2026",
      capacity: { level: "high" as const, confidence: "high" as const, observationCount: 4, basis: ["self_report" as const], blockers: [] },
      primary: { id: "paper", title: "完成论文结果段", identityId: "research", estimate: { p25Minutes: 45, p50Minutes: 60, p85Minutes: 90, confidence: "low", source: "identity_prior", observationCount: 0 }, energy: "high", reason: "推进本周科研里程碑", milestone: "完成当前实验与论文结果段", inputsReady: true },
      lowEnergy: { id: "meal", title: "准备晚饭", identityId: "capacity", estimate: { p25Minutes: 15, p50Minutes: 25, p85Minutes: 35, confidence: "high", source: "personal_history", observationCount: 6 }, energy: "low", reason: "保护晚间容量", milestone: "健康红线", inputsReady: true },
      shortGap: { id: "reply", title: "确认会议", identityId: "startup", estimate: { p25Minutes: 5, p50Minutes: 10, p85Minutes: 15, confidence: "high", source: "personal_history", observationCount: 6 }, energy: "low", reason: "适合短空档", milestone: "验证首个客户问题", inputsReady: true },
      care: [{ title: "睡眠", minimumMinutes: 420 }],
      identities: [
        { id: "research", label: "科研", accent: "#6D5EF5", completedCount: 1, activeMilestone: "完成当前实验与论文结果段", taskCount: 3 },
        { id: "startup", label: "创业", accent: "#FF8A5B", completedCount: 0, activeMilestone: "验证首个客户问题", taskCount: 2 },
        { id: "media", label: "自媒体", accent: "#E85D9E", completedCount: 0, activeMilestone: "发布首个复用内容", taskCount: 1 },
        { id: "investment", label: "投资", accent: "#23A989", completedCount: 2, activeMilestone: "完成本周研究备忘录", taskCount: 2 }
      ],
      upcoming: [],
      localActivityAsked: true, lastNight: { state: "none" as const }, milestonePulse: []
    }} />);

    expect(html).toContain("下一行动");
    expect(html).toContain("完成论文结果段");
    expect(html).toContain("低精力备选");
    expect(html).toContain("短空档备选");
    for (const label of ["科研", "创业", "自媒体", "投资"]) expect(html).toContain(label);
  });

  test("includes a usable quick capture form", () => {
    const html = renderToStaticMarkup(<DashboardView data={{
      nowLabel: "周一 · 09:00", nowIso: "2026-09-14T14:00:00.000Z", timeZone: "America/Chicago", clockPinned: true,
      dateLabel: "14",
      monthLabel: "SEP · 2026",
      capacity: { level: "uncalibrated" as const, observationCount: 0, basis: [], blockers: [{ code: "LOCAL_ACTIVITY_NOT_AUTHORISED", message: "本机活动采集未开启" }] },
      care: [],
      identities: [],
      upcoming: [],
      localActivityAsked: true, lastNight: { state: "none" as const }, milestonePulse: []
    }} />);
    expect(html).toContain("快速收集");
    expect(html).toContain('name="title"');
    expect(html).not.toContain('name="identityId"');
    expect(html).not.toContain('name="expectedMinutes"');
  });

  test("uses a running head instead of a SaaS sidebar and keeps health in the care band", () => {
    const html = renderToStaticMarkup(<DashboardView data={{
      nowLabel: "周一 · 09:00", nowIso: "2026-09-14T14:00:00.000Z", timeZone: "America/Chicago", clockPinned: true, dateLabel: "14", monthLabel: "SEP · 2026",
      capacity: { level: "uncalibrated" as const, observationCount: 0, basis: [], blockers: [{ code: "LOCAL_ACTIVITY_NOT_AUTHORISED", message: "本机活动采集未开启" }] },
      care: [],
      identities: [], upcoming: [], localActivityAsked: true, lastNight: { state: "none" as const }, milestonePulse: []
    }} />);
    expect(html).toContain("running-head");
    expect(html).not.toContain("sidebar");
    expect(html).toContain("CARE / CAPACITY");
    expect(html).toContain("Milestones");
    expect(html).toContain("Workbench");
  });
});

describe("dashboard view honesty", () => {
  const data = {
    nowLabel: "周一 · 09:00", nowIso: "2026-09-14T14:00:00.000Z", timeZone: "America/Chicago", clockPinned: true, dateLabel: "14", monthLabel: "SEP · 2026",
    capacity: { level: "uncalibrated" as const, observationCount: 0, basis: [], blockers: [{ code: "LOCAL_ACTIVITY_NOT_AUTHORISED", message: "本机活动采集未开启" }] },
    care: [],
    identities: [], upcoming: [], localActivityAsked: true, lastNight: { state: "none" as const }, milestonePulse: []
  };

  test("does not render a hardcoded year progress bar", () => {
    const html = renderToStaticMarkup(<DashboardView data={data} />);
    expect(html).not.toContain("YEAR PROGRESS");
    expect(html).not.toContain("70%");
    expect(html).not.toContain("year-track");
  });

  test("does not claim a live system state it never measured", () => {
    const html = renderToStaticMarkup(<DashboardView data={data} />);
    expect(html).not.toContain("LIVE");
  });
});

describe("capacity honesty", () => {
  const withCapacity = (capacity: DashboardData["capacity"]) => renderToStaticMarkup(<DashboardView data={{
    nowLabel: "周一 · 09:00", nowIso: "2026-09-14T14:00:00.000Z", timeZone: "America/Chicago", clockPinned: true, dateLabel: "14", monthLabel: "SEP · 2026",
    capacity, care: [], identities: [], upcoming: [], localActivityAsked: true, lastNight: { state: "none" as const }, milestonePulse: []
  }} />);

  test("names what the reading was derived from instead of calling everything a self-report", () => {
    const html = withCapacity({ level: "low", confidence: "low", observationCount: 21,
      basis: ["local_activity", "execution_history"], blockers: [] });
    expect(html).toContain("依据 本机活动 + 执行记录");
    expect(html).toContain("21 次观测");
    expect(html).not.toContain("次自评");
  });

  test("an uncalibrated reading shows why, not a level", () => {
    const html = withCapacity({ level: "uncalibrated", observationCount: 3, basis: [],
      blockers: [{ code: "BASELINE_INSUFFICIENT", message: "需要至少 14 天本机活动观测" }] });
    expect(html).toContain("精力未标定");
    expect(html).toContain("需要至少 14 天本机活动观测");
  });
});

describe("last night's expansion", () => {
  const withLastNight = (lastNight: DashboardData["lastNight"]) => renderToStaticMarkup(<DashboardView data={{
    nowLabel: "周一 · 09:00", nowIso: "2026-09-14T14:00:00.000Z", timeZone: "America/Chicago", clockPinned: true, dateLabel: "14", monthLabel: "SEP · 2026",
    capacity: { level: "uncalibrated", observationCount: 0, basis: [], blockers: [] },
    care: [], identities: [], upcoming: [], localActivityAsked: true, lastNight, milestonePulse: []
  }} />);

  test("a night that did not run says so with its reason, instead of showing older output as new", () => {
    const html = withLastNight({ state: "skipped", reason: "读不到成本信号，今晚不运行：supervisor down" });
    expect(html).toContain("昨夜未运行");
    expect(html).toContain("supervisor down");
  });

  test("a night that ran reports how many candidates it produced", () => {
    expect(withLastNight({ state: "ran", proposals: 4 })).toContain("昨夜扩展 · 产出 4 条候选");
  });

  test("no record at all shows nothing rather than an invented status", () => {
    const html = withLastNight({ state: "none" });
    expect(html).not.toContain("昨夜");
  });
});
