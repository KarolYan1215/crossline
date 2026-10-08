/**
 * The one navigation list every header reads from.
 *
 * Four working views and nothing else in the main row: what to do now (今日), what the lines are working
 * towards (主线), when it happens (计划), and the work itself (任务). What is waiting for a decision (待确认) and the
 * settings sit to the side, because they are visited when something asks, not as a place to work.
 */
export const NAV_ITEMS = [
  { label: "今日", href: "/" },
  { label: "主线", href: "/milestones" },
  { label: "计划", href: "/plan" },
  { label: "任务", href: "/workbench" }
] as const;

export const SIDE_ITEMS = [
  { label: "待确认", href: "/approvals", badge: true },
  { label: "设置", href: "/settings", badge: false }
] as const;
