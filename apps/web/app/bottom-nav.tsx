"use client";
import { NAV_ITEMS, SECONDARY_ITEMS } from "./nav-items";
import { PendingBadge } from "./pending-badge";
import { useT } from "./locale-context";
import { NavLink } from "./ui/nav-link";
import { SignOutButton } from "./sign-out-button";

// The four working views are the tab bar; what is waiting and the settings sit behind a fifth, because a bottom
// bar with six entries is not one a thumb can hit reliably. A native disclosure needs no client script to open.
export function BottomNav({ active }: { active?: string | undefined }) {
  const t = useT();
  return <nav className="bottom-nav" aria-label={t("主导航（移动端）")}>
    {NAV_ITEMS.map((item) => <NavLink key={item.label} href={item.href} className={item.label === active ? "active" : ""}>{t(item.label)}</NavLink>)}
    <details className="bottom-nav-more">
      <summary>{t("更多")}<PendingBadge /></summary>
      <div className="bottom-nav-more-panel">
        {SECONDARY_ITEMS.map((item) => <NavLink key={item.label} href={item.href} className={item.label === active ? "active" : ""}>{t(item.label)}{item.badge && <PendingBadge />}</NavLink>)}
        {/* On a phone signing out lives here, so the header's controls stay on one row (2026-10-28). */}
        <SignOutButton />
      </div>
    </details>
  </nav>;
}
