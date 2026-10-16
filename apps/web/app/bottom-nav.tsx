"use client";
import { NAV_ITEMS, SIDE_ITEMS } from "./nav-items";
import { PendingBadge } from "./pending-badge";
import { useT } from "./locale-context";
import { LocaleSwitch } from "./locale-switch";

// The four working views are the tab bar; what is waiting and the settings sit behind a fifth, because a bottom
// bar with six entries is not one a thumb can hit reliably. A native disclosure needs no client script to open.
export function BottomNav({ active }: { active?: string | undefined }) {
  const t = useT();
  return <nav className="bottom-nav" aria-label={t("主导航（移动端）")}>
    {NAV_ITEMS.map((item) => <a key={item.label} href={item.href} className={item.label === active ? "active" : ""}>{t(item.label)}</a>)}
    <details className="bottom-nav-more">
      <summary>{t("更多")}<PendingBadge /></summary>
      <div className="bottom-nav-more-panel">
        {SIDE_ITEMS.map((item) => <a key={item.label} href={item.href} className={item.label === active ? "active" : ""}>{t(item.label)}{item.badge && <PendingBadge />}</a>)}
        {/* On a phone the header's language switch lives here (docs/i18n.md); the header's own is hidden at this width (mobile.css). */}
        <LocaleSwitch />
      </div>
    </details>
  </nav>;
}
