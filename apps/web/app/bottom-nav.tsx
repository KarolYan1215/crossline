import { NAV_ITEMS } from "./nav-items";

// Four fixed entries plus a fifth disclosure for the rest — a bottom tab bar is the layout mobile
// productivity apps converge on, and it replaces the plain-text `nav` that used to wrap onto two or
// three lines at phone width (`.running-head nav{flex-wrap:wrap}` had no mobile-specific rule at all).
const PRIMARY = new Set(["Today", "Plan", "Workbench", "Approvals"]);

export function BottomNav({ active }: { active?: string }) {
  const primary = NAV_ITEMS.filter((item) => PRIMARY.has(item.label));
  const more = NAV_ITEMS.filter((item) => !PRIMARY.has(item.label));
  return <nav className="bottom-nav" aria-label="主导航（移动端）">
    {primary.map((item) => <a key={item.label} href={item.href} className={item.label === active ? "active" : ""}>{item.label}</a>)}
    {/* A native disclosure needs no client script to open — the same reason `.work-order-drawer`
        elsewhere in this app is a plain `<details>` rather than a JS-driven popover. */}
    <details className="bottom-nav-more">
      <summary>更多</summary>
      <div className="bottom-nav-more-panel">
        {more.map((item) => <a key={item.label} href={item.href} className={item.label === active ? "active" : ""}>{item.label}</a>)}
      </div>
    </details>
  </nav>;
}
