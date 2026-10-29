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
 * The side bar's groups (2026-10-28 frame redesign; the rhythm group 2026-10-29, docs/plans/page-drafts-1028/scenarios.md §4): the four
 * working views with 待确认 under them; under 「节奏与回顾」 the week's commitment, the day's wrap-up, the weekly review and the portrait;
 * importing and the settings at the foot. The phone's tab bar is 今日 / 主线 / 任务 / 待确认 (`PHONE_TABS`), and 计划 joins the rest behind
 * 「更多」 (`PHONE_MORE`).
 */
export const DECIDE_ITEM = { label: "待确认", href: "/approvals", badge: true } as const;

export const RHYTHM_ITEMS = [
  { label: "本周承诺", href: "/commit", badge: false },
  { label: "收工", href: "/wrap", badge: false },
  { label: "周复盘", href: "/review", badge: false },
  { label: "画像", href: "/portrait", badge: false }
] as const;

export const FOOT_ITEMS = [
  { label: "导入", href: "/settings#import", badge: false },
  { label: "设置", href: "/settings", badge: false }
] as const;

/** Every side-bar entry below the four working views, in order. */
export const SECONDARY_ITEMS = [DECIDE_ITEM, ...RHYTHM_ITEMS, ...FOOT_ITEMS] as const;

export const PHONE_TABS = [
  { label: "今日", href: "/", badge: false },
  { label: "主线", href: "/milestones", badge: false },
  { label: "任务", href: "/workbench", badge: false },
  DECIDE_ITEM
] as const;

export const PHONE_MORE = [{ label: "计划", href: "/plan", badge: false }, ...RHYTHM_ITEMS, ...FOOT_ITEMS] as const;
