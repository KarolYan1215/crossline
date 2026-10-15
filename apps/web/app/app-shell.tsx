import type { ReactNode } from "react";
import { SignOutButton } from "./sign-out-button";
import { NAV_ITEMS, SIDE_ITEMS } from "./nav-items";
import { BottomNav } from "./bottom-nav";
import { CornerStack } from "./corner-stack";
import { RuntimeBanner } from "./runtime-banner";
import { AssistantWidget } from "./assistant-widget";
import { PendingBadge } from "./pending-badge";
import { TimerFloat } from "./task/timer-float";
import { UndoCenter } from "./undo-center";
import { LineColors } from "./line-colors";
import { CameraSampler } from "./camera-sampler";
import { ReturnPoint } from "./ui/back-link";

/**
 * The frame every signed-in page shares: the name, the four working views, the decisions waiting for you, the
 * settings, and the assistant. Pages put their content inside it and say which view they are.
 */
export function AppShell({ active, children, className = "page", focus = false, corner = !focus }: { active?: string | undefined; children: ReactNode; className?: string;
  /** The interview before the start standard stands (docs/onboarding-v3.md): every working view would lead back to it, so none is offered, and no assistant. */
  focus?: boolean;
  /** The timer and 小帮手 corner; off on a page that is itself the conversation. */
  corner?: boolean }) {
  return <>
    <LineColors />
    {/* Every page in the frame is left and returned to as it was: scroll, open folds, and what components register. */}
    <ReturnPoint />
    <header className="running-head">
      <a className="wordmark" href="/">Crossline</a>
      <nav aria-label="主导航">{(focus ? [] : NAV_ITEMS).map((item) =>
        <a href={item.href} key={item.label} className={item.label === active ? "active" : ""} aria-current={item.label === active ? "page" : undefined}>{item.label}</a>)}</nav>
      <div className="system-state">
        {(focus ? SIDE_ITEMS.filter((item) => item.href === "/settings") : SIDE_ITEMS).map((item) => <a href={item.href} key={item.label} className={item.label === active ? "active" : ""} aria-current={item.label === active ? "page" : undefined}>
          {item.label}{item.badge && <PendingBadge />}</a>)}
        <UndoCenter />
        <SignOutButton />
      </div>
    </header>
    {!focus && <BottomNav active={active} />}
    {/* One corner, stacked: the timer above the 小帮手 bubble, each as tall as it is, so neither covers the other's buttons. */}
    {corner && <CornerStack>
      <CameraSampler />
      <TimerFloat />
      <AssistantWidget />
    </CornerStack>}
    <main className={className}><RuntimeBanner />{children}</main>
  </>;
}
