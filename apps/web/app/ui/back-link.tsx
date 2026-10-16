"use client";

import { useEffect, useState, type MouseEvent } from "react";
import { useT } from "../locale-context";
import { forgetReturnDecision, lastPage, markReturning, pageKey, restoreFrame, returningSnapshot, saveReturnState } from "./return-state";

/**
 * Mounted once by the shared frame: saves the page's state as the person leaves it (a click that may navigate, a fold toggled, scrolling,
 * the page being hidden) and restores it when the page is returned to.
 */
export function ReturnPoint() {
  useEffect(() => {
    const snapshot = returningSnapshot();
    if (snapshot) restoreFrame(snapshot);
    let timer = 0;
    const save = () => saveReturnState();
    const onScroll = () => { window.clearTimeout(timer); timer = window.setTimeout(save, 200); };
    // A page restored whole from the back/forward cache needs nothing restored, only the returning mark taken off.
    const onShow = (event: PageTransitionEvent) => { if (event.persisted) { forgetReturnDecision(); returningSnapshot(); } };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", save);
    window.addEventListener("pageshow", onShow);
    document.addEventListener("click", save, true);
    document.addEventListener("toggle", save, true);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", save);
      window.removeEventListener("pageshow", onShow);
      document.removeEventListener("click", save, true);
      document.removeEventListener("toggle", save, true);
      forgetReturnDecision();
    };
  }, []);
  return null;
}

/** What each view is called on the back button. */
const PLACES: Array<[RegExp, string]> = [
  [/^\/$/, "今日"], [/^\/milestones/, "主线"], [/^\/plan/, "计划"], [/^\/workbench\/?$/, "任务"], [/^\/workbench\//, "任务"],
  [/^\/approvals/, "待确认"], [/^\/review/, "周回顾"], [/^\/settings/, "设置"], [/^\/return/, "回顾"], [/^\/confirm/, "完成确认"], [/^\/portrait/, "画像"]
];
export const placeLabel = (path: string): string => PLACES.find(([pattern]) => pattern.test(path.split(/[?#]/)[0] ?? path))?.[1] ?? "上一页";

const ORIGIN = "crossline:origin:";

/**
 * Where this page was opened from, decided once when it loads and kept for its own subpages (a task's material page and back again).
 * Opened by a typed or shared link, or from a notification, there is no origin and `fallback` is used. Exported for its test.
 */
export function resolveOrigin(scope: string, { referrer, last, stored, reload }: { referrer: string; last: string | null; stored: string | null; reload: boolean }): string | null {
  const within = (path: string) => path === scope || path.startsWith(`${scope}/`) || path.startsWith(`${scope}?`) || path.startsWith(`${scope}#`);
  let from: URL | null = null;
  try { from = referrer ? new URL(referrer) : null; } catch { from = null; }
  const sameSite = from && typeof location !== "undefined" ? from.origin === location.origin : Boolean(from);
  if (!from || !sameSite) return reload ? stored : null;
  const path = `${from.pathname}${from.search}`;
  if (within(from.pathname)) return stored;
  // The last page left carries the address it had when it was left (a filter chosen after it loaded); prefer it when it is that page.
  return last && last.split("?")[0] === from.pathname ? last : path;
}

/**
 * 「← 返回今日」: back to the page this one was opened from, as it was left — the browser's own back when that page is the previous
 * entry, else a navigation to it with its saved state restored. Without an origin it goes to `fallback`.
 */
export function BackLink({ scope, fallback = "/workbench" }: { scope: string; fallback?: string }) {
  const t = useT();
  const [origin, setOrigin] = useState<string | null>(null);
  useEffect(() => {
    let stored: string | null = null;
    try { stored = window.sessionStorage.getItem(`${ORIGIN}${scope}`); } catch { stored = null; }
    let reload = false;
    try { reload = (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type === "reload"; } catch { reload = false; }
    const resolved = resolveOrigin(scope, { referrer: document.referrer, last: lastPage(), stored, reload });
    try {
      if (resolved) window.sessionStorage.setItem(`${ORIGIN}${scope}`, resolved);
      else window.sessionStorage.removeItem(`${ORIGIN}${scope}`);
    } catch { /* storage blocked: the link still works, without memory */ }
    setOrigin(resolved && resolved !== pageKey() ? resolved : null);
  }, [scope]);
  const target = origin ?? fallback;
  const go = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    markReturning(target);
    let previous = "";
    try { const from = new URL(document.referrer); previous = from.origin === location.origin ? `${from.pathname}${from.search}` : ""; } catch { previous = ""; }
    if (origin && previous === origin && window.history.length > 1) window.history.back();
    else window.location.assign(target);
  };
  return <a className="back-link" href={target} onClick={go}><span aria-hidden="true">←</span> {t("返回{{place}}", { place: t(placeLabel(target)) })}</a>;
}
