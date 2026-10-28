"use client";
import { NAV_ITEMS, SIDE_ITEMS } from "./nav-items";
import { PendingBadge } from "./pending-badge";
import { UndoCenter } from "./undo-center";
import { SignOutButton } from "./sign-out-button";
import { LocaleSwitch } from "./locale-switch";
import { NoticeBell } from "./notice-bell";
import { useT } from "./locale-context";
import { NavLink } from "./ui/nav-link";

/** The header every signed-in page shares (from `AppShell`); a client component so its labels follow the page's language (docs/i18n.md). */
export function RunningHead({ active, focus }: { active?: string | undefined; focus: boolean }) {
  const t = useT();
    return <header className="running-head" data-focus={focus || undefined}>
    <NavLink className="wordmark" href="/">Crossline</NavLink>
    <nav aria-label={t("主导航")}>{(focus ? [] : NAV_ITEMS).map((item) =>
      <NavLink href={item.href} key={item.label} className={item.label === active ? "active" : ""} aria-current={item.label === active ? "page" : undefined}>{t(item.label)}</NavLink>)}</nav>
    <div className="system-state">
      {(focus ? SIDE_ITEMS.filter((item) => item.href === "/settings") : SIDE_ITEMS).map((item) => <NavLink href={item.href} key={item.label} className={item.label === active ? "active" : ""} aria-current={item.label === active ? "page" : undefined}>
        {t(item.label)}{item.badge && <PendingBadge />}</NavLink>)}
      {!focus && <NoticeBell />}
      <LocaleSwitch sync />
      <UndoCenter />
      <SignOutButton />
    </div>
  </header>;
}
