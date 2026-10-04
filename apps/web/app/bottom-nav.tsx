import { NAV_ITEMS, SIDE_ITEMS } from "./nav-items";
import { PendingBadge } from "./pending-badge";

// The four working views are the tab bar; what is waiting and the settings sit behind a fifth, because a bottom
// bar with six entries is not one a thumb can hit reliably. A native disclosure needs no client script to open.
export function BottomNav({ active }: { active?: string | undefined }) {
  return <nav className="bottom-nav" aria-label="主导航（移动端）">
    {NAV_ITEMS.map((item) => <a key={item.label} href={item.href} className={item.label === active ? "active" : ""}>{item.label}</a>)}
    <details className="bottom-nav-more">
      <summary>更多<PendingBadge /></summary>
      <div className="bottom-nav-more-panel">
        {SIDE_ITEMS.map((item) => <a key={item.label} href={item.href} className={item.label === active ? "active" : ""}>{item.label}{item.badge && <PendingBadge />}</a>)}
      </div>
    </details>
  </nav>;
}
