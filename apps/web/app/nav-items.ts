/**
 * The one navigation list every header reads from.
 *
 * The side bar (2026-11-10, the owner's restructure): the working views — what to do now (今日), what the lines are working towards
 * (主线), the money (记账本, beside the lines it serves) and the work itself (任务) — with 待确认 under them; under 「节奏与回顾」 the
 * one page 「计划与复盘」 (tabs 本周承诺 / 计划 / 收工 / 周复盘) and the portrait; under 「Agent」 what the agents made (Agent 产出) and
 * what runs by itself (自动化); importing and the settings at the foot.
 */
// `label` is also the id a page passes as `active`: it stays the Chinese key and is translated where it is shown (docs/i18n.md).

/**
 * The running head's row under 1025px (no side bar): four views, with 待确认 and 设置 to the side (`SIDE_ITEMS`). `short` is the shown
 * name where the full one would push the row onto two lines at tablet width; the page still marks itself by `label`.
 */
export const NAV_ITEMS: ReadonlyArray<{ label: string; href: string; short?: string }> = [
  { label: "今日", href: "/" },
  { label: "主线", href: "/milestones" },
  { label: "计划与复盘", href: "/plan", short: "计划" },
  { label: "任务", href: "/workbench" }
];

export const SIDE_ITEMS = [
  { label: "待确认", href: "/approvals", badge: true },
  { label: "设置", href: "/settings", badge: false }
] as const;

/** The side bar's first group: the working views, then 待确认 (`DECIDE_ITEM`). */
export const WORK_ITEMS = [
  { label: "今日", href: "/", badge: false },
  { label: "主线", href: "/milestones", badge: false },
  { label: "记账本", href: "/ledger", badge: false },
  { label: "任务", href: "/workbench", badge: false }
] as const;

export const DECIDE_ITEM = { label: "待确认", href: "/approvals", badge: true } as const;

/** 「计划与复盘」 opens on its 计划 tab; each tab keeps its own address (`PLAN_TABS` in plan-tabs.tsx). */
export const RHYTHM_ITEMS = [
  { label: "计划与复盘", href: "/plan", badge: false },
  { label: "画像", href: "/portrait", badge: false }
] as const;

export const AGENT_ITEMS = [
  { label: "Agent 产出", href: "/outputs", badge: false },
  { label: "自动化", href: "/automation", badge: false }
] as const;

export const FOOT_ITEMS = [
  { label: "导入", href: "/settings#import", badge: false },
  { label: "设置", href: "/settings", badge: false }
] as const;

/** Every side-bar entry below the working views, in order. */
export const SECONDARY_ITEMS = [DECIDE_ITEM, ...RHYTHM_ITEMS, ...AGENT_ITEMS, ...FOOT_ITEMS] as const;

/** The phone's tab bar: four tabs and 「更多」 (`PHONE_MORE`). */
export const PHONE_TABS = [
  { label: "今日", href: "/", badge: false },
  { label: "主线", href: "/milestones", badge: false },
  { label: "任务", href: "/workbench", badge: false },
  DECIDE_ITEM
] as const;

export const PHONE_MORE = [RHYTHM_ITEMS[0], { label: "记账本", href: "/ledger", badge: false }, RHYTHM_ITEMS[1], ...AGENT_ITEMS, ...FOOT_ITEMS] as const;
