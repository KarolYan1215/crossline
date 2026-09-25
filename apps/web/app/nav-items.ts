/**
 * The one nav list every header reads from. `dashboard-view.tsx` and `subpage-shell.tsx` used to each
 * keep their own — different shapes, and already drifted (`SubpageShell`'s never got an `active` state
 * at all) — so this is also what `BottomNav` (`bottom-nav.tsx`) renders from, rather than a third copy.
 */
export const NAV_ITEMS = [
  { label: "Today", href: "/" },
  { label: "Plan", href: "/plan" },
  { label: "Milestones", href: "/milestones" },
  { label: "Workbench", href: "/workbench" },
  { label: "Approvals", href: "/approvals" },
  { label: "Review", href: "/review" },
  { label: "Connections", href: "/connectors" }
] as const;
