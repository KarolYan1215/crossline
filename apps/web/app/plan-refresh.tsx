"use client";

import { useEffect } from "react";
import { useAppRouter } from "./ui/use-app-router";

export const PLAN_CHANGED = "crossline:plan-changed";

/** Calls `refresh` once for each burst of plan-changed events on `target`; returns the clean-up. Exported for its test. */
export function listenForPlanChanges(target: EventTarget, refresh: () => void, delayMs = 150): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Several events in one moment (pending + plan, two actions on one card) are one refresh.
  const onChange = () => { clearTimeout(timer); timer = setTimeout(refresh, delayMs); };
  target.addEventListener(PLAN_CHANGED, onChange);
  return () => { clearTimeout(timer); target.removeEventListener(PLAN_CHANGED, onChange); };
}

/**
 * Draws the page's server parts again when something the person carried out changed the plan (`crossline:plan-changed`, fired by the
 * input box after 执行 or 撤销). Without it an event added from the box was written and the day's timeline went on showing the old blocks
 * until a reload (W-142).
 */
export function PlanRefresh() {
  const router = useAppRouter();
  useEffect(() => router ? listenForPlanChanges(window, () => router.refresh()) : undefined, [router]);
  return null;
}
