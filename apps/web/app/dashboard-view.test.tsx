import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
// `dashboard-view.tsx` → `task-preview.tsx` imports `lib/task-detail.ts` for its `TaskDetail`/
// `MilestoneDetail` types, which pulls in that module's `import "server-only"` at runtime regardless —
// no real store call happens (every fixture below hands in an empty Map, so `TaskPreview`/
// `MilestonePreview` never call `loadTaskDetail`/`loadMilestoneDetail`), but the module load itself
// still needs the mock.
vi.mock("server-only", () => ({}));
import { DashboardView, type DashboardData } from "./dashboard-view";

const noPreviews = { taskDetailById: new Map(), milestoneDetailById: new Map() };

describe("dashboard view", () => {
  test("renders one next action, two alternatives, and all identity lanes", () => {
    const html = renderToStaticMarkup(<DashboardView data={{
      principalId: "test-owner", workspaceId: "test-workspace", nowLabel: "周一 · 09:00", nowIso: "2026-09-14T14:00:00.000Z", timeZone: "America/Chicago", clockPinned: true,
      dateLabel: "14",
      monthLabel: "SEP · 2026",
      capacity: { level: "high" as const, confidence: "high" as const, observationCount: 4, basis: ["self_report" as const], blockers: [] },
      primary: { id: "paper", title: "完成论文结果段", identityId: "research", estimate: { p25Minutes: 45, p50Minutes: 60, p85Minutes: 90, confidence: "low", source: "identity_prior", observationCount: 0 }, energy: "high", reason: "推进本周科研里程碑", milestone: "完成当前实验与论文结果段", inputsReady: true },
      lowEnergy: { id: "meal", title: "准备晚饭", identityId: "capacity", estimate: { p25Minutes: 15, p50Minutes: 25, p85Minutes: 35, confidence: "high", source: "personal_history", observationCount: 6 }, energy: "low", reason: "保护晚间容量", milestone: "健康红线", inputsReady: true },
      shortGap: { id: "reply", title: "确认会议", identityId: "startup", estimate: { p25Minutes: 5, p50Minutes: 10, p85Minutes: 15, confidence: "high", source: "personal_history", observationCount: 6 }, energy: "low", reason: "适合短空档", milestone: "验证首个客户问题", inputsReady: true },
      progress: { streakDays: 3, weekCount: 5 },
      care: [{ title: "睡眠", minimumMinutes: 420 }],
      identities: [
        { id: "research", label: "科研", accent: "#6D5EF5", completedCount: 1, activeMilestone: "完成当前实验与论文结果段", taskCount: 3, totalCount: 4, pct: 25 },
        { id: "startup", label: "创业", accent: "#FF8A5B", completedCount: 0, activeMilestone: "验证首个客户问题", taskCount: 2, totalCount: 2, pct: 0 },
        { id: "media", label: "自媒体", accent: "#E85D9E", completedCount: 0, activeMilestone: "发布首个复用内容", taskCount: 1, totalCount: 1, pct: 0 },
        { id: "investment", label: "投资", accent: "#23A989", completedCount: 2, activeMilestone: "完成本周研究备忘录", taskCount: 2, totalCount: 4, pct: 50 }
      ],
      upcoming: [],
      localActivityAsked: true, lastNight: { state: "none" as const }, milestonePulse: [], todayCapacity: { availableMinutes: 0, committedMinutes: 0 }, flywheel: [], flywheelStrip: { nodes: [], edges: [] },
      ...noPreviews
    }} />);

    expect(html).toContain("下一步");
    expect(html).toContain("完成论文结果段");
    expect(html).toContain("低精力备选");
    expect(html).toContain("短空档备选");
    for (const label of ["科研", "创业", "自媒体", "投资"]) expect(html).toContain(label);
  });

  test("工作块 F: a card with a loaded TaskDetail gets inline start/complete controls, not a link to Workbench", () => {
    const taskDetailById = new Map([["paper", {
      id: "paper", ownerId: "test-owner", workspaceId: "test-workspace", paused: false,
      identityId: "research", identityLabel: "科研", accent: "#6D5EF5", intent: "完成论文结果段",
      state: "ready_for_human", riskTier: "milestone" as const,
      estimate: { p25Minutes: 45, p50Minutes: 60, p85Minutes: 90, confidence: "low" as const, source: "identity_prior" as const, observationCount: 0 },
      manualPromotion: false, seeded: false, humanCore: [], automationParts: [], estimateBreakdown: [], byproducts: [], materialContract: [], evidenceContract: [], evidenceChecklist: [],
      preparedMaterials: [], executions: [], relatedFlywheel: [], background: null
    }]]);
    const html = renderToStaticMarkup(<DashboardView data={{
      principalId: "test-owner", workspaceId: "test-workspace", nowLabel: "周一 · 09:00", nowIso: "2026-09-14T14:00:00.000Z", timeZone: "America/Chicago", clockPinned: true,
      dateLabel: "14",
      monthLabel: "SEP · 2026",
      capacity: { level: "high" as const, confidence: "high" as const, observationCount: 4, basis: ["self_report" as const], blockers: [] },
      primary: { id: "paper", title: "完成论文结果段", identityId: "research", estimate: { p25Minutes: 45, p50Minutes: 60, p85Minutes: 90, confidence: "low", source: "identity_prior", observationCount: 0 }, energy: "high", reason: "推进本周科研里程碑", milestone: "完成当前实验与论文结果段", inputsReady: true },
      progress: { streakDays: 3, weekCount: 5 },
      care: [],
      identities: [],
      upcoming: [],
      localActivityAsked: true, lastNight: { state: "none" as const }, milestonePulse: [], todayCapacity: { availableMinutes: 0, committedMinutes: 0 }, flywheel: [], flywheelStrip: { nodes: [], edges: [] },
      taskDetailById, milestoneDetailById: new Map()
    }} />);
    expect(html).toContain("开始执行");
    expect(html).not.toContain("前往任务详情执行并提交证据");
    // The day head already has an energy probe — the embedded
    // ExecutionActions must not add a second "记录中精力" control next to it.
    expect(html).not.toContain("开始前精力");
    // The inline controls replace the old CTA, but the hero card still needs a way to reach the
    // full detail page (background facts, material/evidence contracts, execution history).
    expect(html).toContain('href="/workbench/paper"');
    expect(html).toContain("完整详情");
  });

  test("includes a usable quick capture form", () => {
    const html = renderToStaticMarkup(<DashboardView data={{
      principalId: "test-owner", workspaceId: "test-workspace", nowLabel: "周一 · 09:00", nowIso: "2026-09-14T14:00:00.000Z", timeZone: "America/Chicago", clockPinned: true,
      dateLabel: "14",
      monthLabel: "SEP · 2026",
      capacity: { level: "uncalibrated" as const, observationCount: 0, basis: [], blockers: [{ code: "LOCAL_ACTIVITY_NOT_AUTHORISED", message: "本机活动采集未开启" }] },
      progress: { streakDays: 0, weekCount: 0 },
      care: [],
      identities: [],
      upcoming: [],
      localActivityAsked: true, lastNight: { state: "none" as const }, milestonePulse: [], todayCapacity: { availableMinutes: 0, committedMinutes: 0 }, flywheel: [], flywheelStrip: { nodes: [], edges: [] },
      ...noPreviews
    }} />);
    expect(html).toContain("快速收集");
    expect(html).toContain('name="title"');
    expect(html).not.toContain('name="identityId"');
    expect(html).not.toContain('name="expectedMinutes"');
  });

  test("uses a running head with the four working views, not a SaaS sidebar", () => {
    const html = renderToStaticMarkup(<DashboardView data={{
      principalId: "test-owner", workspaceId: "test-workspace", nowLabel: "周一 · 09:00", nowIso: "2026-09-14T14:00:00.000Z", timeZone: "America/Chicago", clockPinned: true, dateLabel: "14", monthLabel: "SEP · 2026",
      capacity: { level: "uncalibrated" as const, observationCount: 0, basis: [], blockers: [{ code: "LOCAL_ACTIVITY_NOT_AUTHORISED", message: "本机活动采集未开启" }] },
      progress: { streakDays: 0, weekCount: 0 },
      care: [],
      identities: [], upcoming: [], localActivityAsked: true, lastNight: { state: "none" as const }, milestonePulse: [], todayCapacity: { availableMinutes: 0, committedMinutes: 0 }, flywheel: [], flywheelStrip: { nodes: [], edges: [] },
      ...noPreviews
    }} />);
    expect(html).toContain("running-head");
    expect(html).not.toContain("sidebar");
    for (const label of ["今日", "主线", "计划", "任务", "待确认", "设置"]) expect(html).toContain(label);
    expect(html).not.toContain("CARE / CAPACITY");
  });
});

describe("dashboard view honesty", () => {
  const data = {
    principalId: "test-owner", workspaceId: "test-workspace", nowLabel: "周一 · 09:00", nowIso: "2026-09-14T14:00:00.000Z", timeZone: "America/Chicago", clockPinned: true, dateLabel: "14", monthLabel: "SEP · 2026",
    capacity: { level: "uncalibrated" as const, observationCount: 0, basis: [], blockers: [{ code: "LOCAL_ACTIVITY_NOT_AUTHORISED", message: "本机活动采集未开启" }] },
    progress: { streakDays: 0, weekCount: 0 },
    care: [],
    identities: [], upcoming: [], localActivityAsked: true, lastNight: { state: "none" as const }, milestonePulse: [], todayCapacity: { availableMinutes: 0, committedMinutes: 0 }, flywheel: [], flywheelStrip: { nodes: [], edges: [] },
    ...noPreviews
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
    principalId: "test-owner", workspaceId: "test-workspace", nowLabel: "周一 · 09:00", nowIso: "2026-09-14T14:00:00.000Z", timeZone: "America/Chicago", clockPinned: true, dateLabel: "14", monthLabel: "SEP · 2026",
    capacity, progress: { streakDays: 0, weekCount: 0 }, care: [], identities: [], upcoming: [], localActivityAsked: true, lastNight: { state: "none" as const }, milestonePulse: [], todayCapacity: { availableMinutes: 0, committedMinutes: 0 }, flywheel: [], flywheelStrip: { nodes: [], edges: [] },
    ...noPreviews
  }} />);

  test("names what the reading was derived from instead of calling everything a self-report", () => {
    const html = withCapacity({ level: "low", confidence: "low", observationCount: 21,
      basis: ["local_activity", "execution_history"], blockers: [] });
    expect(html).toContain("依据 本机活动 + 执行记录");
    expect(html).toContain("21 次观测");
    expect(html).not.toContain("次自评");
  });

  // The calibration note is about the system, not something to act on today: it is not printed on Today any more.
  test("an uncalibrated reading says so without a note about the system's own baseline", () => {
    const html = withCapacity({ level: "uncalibrated", observationCount: 3, basis: [],
      blockers: [{ code: "BASELINE_INSUFFICIENT", message: "需要至少 14 天本机活动观测" }] });
    expect(html).toContain("精力未标定");
    expect(html).not.toContain("需要至少 14 天本机活动观测");
  });
});

// The nightly expansion's status moved to 设置 (it is about the system, not about the day).
test("Today no longer prints the nightly expansion's status", () => {
  const html = renderToStaticMarkup(<DashboardView data={{
    principalId: "test-owner", workspaceId: "test-workspace", nowLabel: "周一 · 09:00", nowIso: "2026-09-14T14:00:00.000Z", timeZone: "America/Chicago", clockPinned: true, dateLabel: "14", monthLabel: "SEP · 2026",
    capacity: { level: "uncalibrated", observationCount: 0, basis: [], blockers: [] },
    progress: { streakDays: 0, weekCount: 0 }, care: [], identities: [], upcoming: [], localActivityAsked: true,
    lastNight: { state: "skipped", reason: "读不到成本信号" }, milestonePulse: [], todayCapacity: { availableMinutes: 0, committedMinutes: 0 }, flywheel: [], flywheelStrip: { nodes: [], edges: [] },
    ...noPreviews
  }} />);
  expect(html).not.toContain("昨夜");
});

describe("dashboard view with nothing to recommend yet", () => {
  const empty = (extra: Partial<DashboardData>) => renderToStaticMarkup(<DashboardView data={{
    principalId: "o", workspaceId: "w", nowLabel: "周一 · 09:00", nowIso: "2026-09-14T14:00:00.000Z", timeZone: "America/Chicago", clockPinned: true,
    dateLabel: "14", monthLabel: "SEP · 2026",
    capacity: { level: "uncalibrated" as const, observationCount: 0, basis: [], blockers: [] },
    progress: { streakDays: 0, weekCount: 0 }, care: [], identities: [], upcoming: [],
    localActivityAsked: true, lastNight: { state: "none" as const }, milestonePulse: [], todayCapacity: { availableMinutes: 0, committedMinutes: 0 }, flywheel: [], flywheelStrip: { nodes: [], edges: [] },
    ...noPreviews, ...extra
  } as DashboardData} />);

  test("with proposals waiting it says so and links to them, instead of asking for more input", () => {
    const html = empty({ awaitingApproval: 2 });
    expect(html).toContain("有 2 个方案在等你批准");
    expect(html).toContain("/approvals#proposals");
    expect(html).not.toContain("先收集一项真实工作");
  });

  test("with nothing at all it asks for a first piece of real work", () => {
    expect(empty({})).toContain("先收集一项真实工作");
  });

  test("quick capture comes before the next action, and its button says what it does", () => {
    const html = empty({});
    expect(html.indexOf("快速收集")).toBeLessThan(html.indexOf("下一步"));
    expect(html).toContain(">收集</button>");
  });
});
