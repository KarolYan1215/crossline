"use client";
import { PHONE_MORE, PHONE_TABS } from "./nav-items";
import { PendingBadge } from "./pending-badge";
import { useT } from "./locale-context";
import { NavLink } from "./ui/nav-link";
import { SignOutButton } from "./sign-out-button";

// The tab bar is what a thumb reaches most: Today, the lines, the tasks and 待确认 (with its count, 2026-10-29: it had been behind 「更多」).
// The plan, the rhythm pages, imports and the settings sit behind a fifth tab. A native disclosure needs no client script to open.
export function BottomNav({ active }: { active?: string | undefined }) {
  const t = useT();
  return <nav className="bottom-nav" aria-label={t("主导航（移动端）")}>
    {PHONE_TABS.map((item) => <NavLink key={item.label} href={item.href} className={item.label === active ? "active" : ""}
      aria-current={item.label === active ? "page" : undefined}>{t(item.label)}{item.badge && <PendingBadge />}</NavLink>)}
    <details className="bottom-nav-more">
      <summary>{t("更多")}</summary>
      <div className="bottom-nav-more-panel">
        {PHONE_MORE.map((item) => <NavLink key={item.label} href={item.href} className={item.label === active ? "active" : ""}>{t(item.label)}</NavLink>)}
        {/* On a phone signing out lives here, so the header's controls stay on one row (2026-10-28). */}
        <SignOutButton />
      </div>
    </details>
  </nav>;
}
