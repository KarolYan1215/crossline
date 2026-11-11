"use client";
import { useT } from "./locale-context";
import { NavLink } from "./ui/nav-link";
import "./plan-tabs.css";

/**
 * 「计划与复盘」 (2026-11-10, the owner): one entry in the side bar for the week's commitment, the plan, the evening wrap-up and the
 * weekly review, drawn as one page with four tabs. Each tab keeps the address it always had, so a link, a notification or a bookmark to
 * any of them still opens that tab, and only the open tab's data is read. Links, not ARIA tabs: each one is a page of its own.
 */
export const PLAN_TABS = [
  { label: "本周承诺", href: "/commit" },
  { label: "计划", href: "/plan" },
  { label: "收工", href: "/wrap" },
  { label: "周复盘", href: "/review" }
] as const;

export type PlanTab = (typeof PLAN_TABS)[number]["label"];

export function PlanTabs({ current }: { current: PlanTab }) {
  const t = useT();
  return <nav className="rhythm-tabs" aria-label={t("计划与复盘")}>
    {PLAN_TABS.map((tab) => <NavLink key={tab.href} href={tab.href} className={tab.label === current ? "active" : ""}
      aria-current={tab.label === current ? "page" : undefined}>{t(tab.label)}</NavLink>)}
  </nav>;
}
