/**
 * The one navigation list every header reads from.
 *
 * Four working views and nothing else in the main row: what to do now (今日), what the lines are working
 * towards (主线), when it happens (计划), and the work itself (任务). What is waiting for a decision (待确认) and the
 * settings sit to the side, because they are visited when something asks, not as a place to work.
 */
// `label` is also the id a page passes as `active`: it stays the Chinese key and is translated where it is shown (docs/i18n.md).
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

/**
 * The side bar's second group (2026-10-28, the frame's redesign): what waits for a decision, bringing work in from other tools, the
 * portrait and the settings. Wider than `SIDE_ITEMS`, which the narrow header keeps short; the phone's 「更多」 lists these too.
 */
export const SECONDARY_ITEMS = [
  { label: "待确认", href: "/approvals", badge: true },
  { label: "导入", href: "/settings#import", badge: false },
  { label: "画像", href: "/portrait", badge: false },
  { label: "设置", href: "/settings", badge: false }
] as const;
