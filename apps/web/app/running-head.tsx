"use client";
import { UserRound } from "lucide-react";
import { NAV_ITEMS, SIDE_ITEMS } from "./nav-items";
import { PendingBadge } from "./pending-badge";
import { UndoCenter } from "./undo-center";
import { SignOutButton, signOutHere } from "./sign-out-button";
import { LocaleSwitch } from "./locale-switch";
import { NoticeBell } from "./notice-bell";
import { TopSearch } from "./top-search";
import { useT } from "./locale-context";
import { NavLink } from "./ui/nav-link";
import { MenuButton } from "./ui/controls";
import { ICON } from "./ui/icon-button";

/**
 * The header every signed-in page shares (from `AppShell`); a client component so its labels follow the page's language (docs/i18n.md).
 * Under 1025px it is the whole navigation (the name, the four views, 待确认 and 设置). On a wider screen the side bar navigates and this
 * is only the cluster at the top right: search, undo, the bell, the language and the account menu (shell.css).
 */
export function RunningHead({ active, focus }: { active?: string | undefined; focus: boolean }) {
  const t = useT();
  const go = (href: string) => () => { location.href = href; };
  return <header className="running-head" data-focus={focus || undefined}>
    <NavLink className="wordmark" href="/">Crossline</NavLink>
    <nav aria-label={t("主导航")}>{(focus ? [] : NAV_ITEMS).map((item) =>
      <NavLink href={item.href} key={item.label} className={item.label === active ? "active" : ""} aria-current={item.label === active ? "page" : undefined}>{t(item.label)}</NavLink>)}</nav>
    <div className="system-state">
      {(focus ? SIDE_ITEMS.filter((item) => item.href === "/settings") : SIDE_ITEMS).map((item) => <NavLink href={item.href} key={item.label} className={item.label === active ? "active" : ""} aria-current={item.label === active ? "page" : undefined}>
        {t(item.label)}{item.badge && <PendingBadge />}</NavLink>)}
      {!focus && <TopSearch />}
      <UndoCenter />
      {!focus && <NoticeBell />}
      <LocaleSwitch sync />
      <SignOutButton />
      {!focus && <span className="account-menu"><MenuButton label={t("账号")} icon={<UserRound {...ICON} />} items={[
        { label: t("设置"), onSelect: go("/settings") },
        { label: t("画像"), onSelect: go("/portrait") },
        { label: t("退出登录"), onSelect: () => { void signOutHere(); } }
      ]} /></span>}
    </div>
  </header>;
}
