import type { ReactNode } from "react";
import { BottomNav } from "./bottom-nav";
import { CornerStack } from "./corner-stack";
import { RuntimeBanner } from "./runtime-banner";
import { AssistantWidget } from "./assistant-widget";
import { TimerFloat } from "./task/timer-float";
import { LineColors } from "./line-colors";
import { CameraSampler } from "./camera-sampler";
import { ReturnPoint } from "./ui/back-link";
import { RunningHead } from "./running-head";
import { SideNav } from "./side-nav";
import { TimeZoneSync } from "./time-zone-sync";
import { HelperCalls } from "./helper-calls";
import { PlanRefresh } from "./plan-refresh";

/**
 * The frame every signed-in page shares: the name, the four working views, the decisions waiting for you, the
 * settings, and the assistant. Pages put their content inside it and say which view they are.
 */
export function AppShell({ active, children, className = "page", focus = false, corner = !focus, banner = true }: { active?: string | undefined; children: ReactNode; className?: string;
  /** The interview before the start standard stands (docs/onboarding-v3.md): every working view would lead back to it, so none is offered, and no assistant. */
  focus?: boolean;
  /** The timer and 小帮手 corner; off on a page that is itself the conversation. */
  corner?: boolean;
  /** The red 「还没有连接模型 … 去连接」 bar; off on the page that is itself where the model is connected (W-5). */
  banner?: boolean }) {
  return <>
    <LineColors />
    {/* Every page in the frame is left and returned to as it was: scroll, open folds, and what components register. */}
    <ReturnPoint />
    {/* A pinned clock (tests, visual baselines) keeps the zone it was set up with. */}
    {!process.env.CROSSLINE_FIXED_NOW && <TimeZoneSync />}
    {/* What the input box carried out shows on the page at once, not after a reload (W-142). */}
    <PlanRefresh />
    {/* On a wide screen the side bar navigates and the running head keeps only its top-right cluster (shell.css). */}
    {!focus && <SideNav active={active} />}
    <RunningHead active={active} focus={focus} />
    {!focus && <BottomNav active={active} />}
    {/* One corner, stacked: the timer above the 小帮手 bubble, each as tall as it is, so neither covers the other's buttons. */}
    {corner && <CornerStack>
      <CameraSampler />
      <TimerFloat />
      <HelperCalls />
      <AssistantWidget />
    </CornerStack>}
    <main className={className}>{banner && <RuntimeBanner />}{children}</main>
  </>;
}
