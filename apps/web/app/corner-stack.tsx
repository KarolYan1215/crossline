"use client";
import { useEffect, useRef, type ReactNode } from "react";

/** Scroll movement under this many pixels does not count as a direction (a trackpad's jitter). */
const SCROLL_STEP = 6;

/**
 * Whether the 小帮手 bubble steps aside while the page scrolls. Room at the page's foot keeps the last thing clear of the corner, but
 * a card scrolled past in the middle of the page still went under the bubble (2026-10-21 walkthrough: Today's cards, the task cards, the
 * phone's 「下一步」). So, as on most phone apps' floating buttons: scrolling down tucks it to the edge, scrolling up, the top of the page
 * and the foot (where the reserved room is) bring it back. Pure, so the rule is tested without a page.
 */
export function nextTucked(state: { tucked: boolean; previousY: number; y: number; viewport: number; documentHeight: number }): boolean {
  const { tucked, previousY, y, viewport, documentHeight } = state;
  if (y < 80 || documentHeight - (y + viewport) < 40) return false;
  if (y - previousY > SCROLL_STEP) return true;
  if (previousY - y > SCROLL_STEP) return false;
  return tucked;
}

/**
 * The fixed bottom-right corner (the timer above the 小帮手 bubble). It records how far up the screen it reaches in
 * `--corner-clearance`, and the page keeps that much room at its foot (composer.css), so the last thing on any page can always be
 * scrolled clear of it instead of sitting under the bubble. While the page scrolls down the bubble tucks to the edge (`nextTucked`);
 * the timer never does, since it shows something running.
 */
export function CornerStack({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const record = () => {
      const reach = el.childElementCount ? Math.max(0, Math.round(window.innerHeight - el.getBoundingClientRect().top)) : 0;
      document.documentElement.style.setProperty("--corner-clearance", `${reach + 12}px`);
    };
    record();
    const observer = new ResizeObserver(record);
    observer.observe(el);
    let previousY = window.scrollY;
    let tucked = false;
    const onScroll = () => {
      const y = window.scrollY;
      const next = nextTucked({ tucked, previousY, y, viewport: window.innerHeight, documentHeight: document.documentElement.scrollHeight });
      if (Math.abs(y - previousY) > SCROLL_STEP || next !== tucked) previousY = y;
      if (next !== tucked) { tucked = next; if (next) el.dataset.tucked = ""; else delete el.dataset.tucked; }
    };
    window.addEventListener("resize", record);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => { observer.disconnect(); window.removeEventListener("resize", record); window.removeEventListener("scroll", onScroll); };
  }, []);
  return <div ref={ref} className="corner-stack">{children}</div>;
}
