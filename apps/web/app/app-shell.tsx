import type { ReactNode } from "react";
import { SignOutButton } from "./sign-out-button";
import { NAV_ITEMS, SIDE_ITEMS } from "./nav-items";
import { BottomNav } from "./bottom-nav";
import { AssistantWidget } from "./assistant-widget";
import { PendingBadge } from "./pending-badge";
import { TimerFloat } from "./task/timer-float";
import { UndoCenter } from "./undo-center";
import { LineColors } from "./line-colors";

/**
 * The frame every signed-in page shares: the name, the four working views, the decisions waiting for you, the
 * settings, and the assistant. Pages put their content inside it and say which view they are.
 */
export function AppShell({ active, children, className = "page" }: { active?: string | undefined; children: ReactNode; className?: string }) {
  return <>
    <LineColors />
    <header className="running-head">
      <a className="wordmark" href="/">Crossline</a>
      <nav aria-label="主导航">{NAV_ITEMS.map((item) =>
        <a href={item.href} key={item.label} className={item.label === active ? "active" : ""} aria-current={item.label === active ? "page" : undefined}>{item.label}</a>)}</nav>
      <div className="system-state">
        {SIDE_ITEMS.map((item) => <a href={item.href} key={item.label} className={item.label === active ? "active" : ""} aria-current={item.label === active ? "page" : undefined}>
          {item.label}{item.badge && <PendingBadge />}</a>)}
        <UndoCenter />
        <SignOutButton />
      </div>
    </header>
    <BottomNav active={active} />
    {/* One corner, stacked: the timer above the 小助手 bubble, each as tall as it is, so neither covers the other's buttons. */}
    <div className="corner-stack">
      <TimerFloat />
      <AssistantWidget />
    </div>
    <main className={className}>{children}</main>
  </>;
}
