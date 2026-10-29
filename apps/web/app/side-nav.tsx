"use client";
import { Activity, CalendarRange, ClipboardCheck, FileInput, Inbox, ListTodo, LogOut, MessageCircle, Moon, Route, ScanFace, Settings, Sun, type LucideIcon } from "lucide-react";
import { DECIDE_ITEM, FOOT_ITEMS, NAV_ITEMS, RHYTHM_ITEMS } from "./nav-items";
import { PendingBadge } from "./pending-badge";
import { LocaleSwitch } from "./locale-switch";
import { SignOutButton } from "./sign-out-button";
import { OPEN_HELPER_EVENT } from "./notice-bell";
import { useT } from "./locale-context";
import { NavLink } from "./ui/nav-link";
import { ICON } from "./ui/icon-button";

/** Each view's icon, by its label (the id pages pass as `active`). */
const ICONS: Record<string, LucideIcon> = { 今日: Sun, 主线: Route, 计划: CalendarRange, 任务: ListTodo, 待确认: Inbox, 导入: FileInput, 画像: ScanFace, 设置: Settings,
  本周承诺: ClipboardCheck, 收工: Moon, 周复盘: Activity };

/**
 * The side bar on a wide screen (2026-10-28, the owner's reference design): the wordmark, the four working views and 待确认; under
 * 「节奏与回顾」 the week's commitment, the wrap-up, the weekly review and the portrait (2026-10-29); then imports and the settings, each an
 * icon and its name; at the foot the 小帮手, the language and signing out. Under 1025px it is not shown and the running head and the
 * phone's tab bar navigate instead (shell.css).
 */
export function SideNav({ active }: { active?: string | undefined }) {
  const t = useT();
  const item = (entry: { label: string; href: string; badge: boolean }) => {
    const Icon = ICONS[entry.label] ?? Sun;
    const current = entry.label === active;
    return <NavLink key={entry.label} href={entry.href} className={current ? "active" : ""} aria-current={current ? "page" : undefined}>
      <Icon {...ICON} /><span>{t(entry.label)}</span>{entry.badge && <PendingBadge />}
    </NavLink>;
  };
  return <aside className="side-nav">
    <NavLink className="side-nav-brand ds-serif" href="/">Crossline</NavLink>
    <nav aria-label={t("主导航")}>
      <div className="side-nav-group">{NAV_ITEMS.map((entry) => item({ ...entry, badge: false }))}{item(DECIDE_ITEM)}</div>
      <div className="side-nav-group" role="group" aria-labelledby="side-nav-rhythm">
        <h2 id="side-nav-rhythm" className="side-nav-heading">{t("节奏与回顾")}</h2>
        {RHYTHM_ITEMS.map(item)}
      </div>
      <div className="side-nav-group">{FOOT_ITEMS.map(item)}</div>
    </nav>
    <div className="side-nav-foot">
      <button type="button" className="side-nav-helper" onClick={() => window.dispatchEvent(new Event(OPEN_HELPER_EVENT))}>
        <MessageCircle {...ICON} /><span>{t("小帮手")}</span>
      </button>
      <LocaleSwitch />
      <SignOutButton icon={<LogOut {...ICON} />} />
    </div>
  </aside>;
}
