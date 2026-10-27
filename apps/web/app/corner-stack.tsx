"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { clampDock, DRAG_THRESHOLD, parseDock, type Dock } from "./helper-pet";

/** Scroll movement under this many pixels does not count as a direction (a trackpad's jitter). */
const SCROLL_STEP = 6;
/** Where the person dragged the corner to, per browser. */
const DOCK_KEY = "crossline.helper.dock";
/** A corner further than this above the viewport's foot is not at the foot: no room is kept for it there. */
const FOOT_BAND = 120;

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
 *
 * The 小帮手 can be dragged (`[data-drag-handle]`), and the whole corner goes with it — the timer stays above it — to where the person
 * puts it, remembered in this browser and kept inside the window when it is resized. A press that barely moves is still a click.
 */
export function CornerStack({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const record = () => {
      const box = el.getBoundingClientRect();
      const atFoot = window.innerHeight - box.bottom < FOOT_BAND;
      const reach = el.childElementCount && atFoot ? Math.max(0, Math.round(window.innerHeight - box.top)) : 0;
      document.documentElement.style.setProperty("--corner-clearance", `${reach + 12}px`);
    };
    let dock: Dock | null = null;
    try { dock = parseDock(window.localStorage.getItem(DOCK_KEY)); } catch { /* storage blocked: the default corner */ }
    const place = (next: Dock | null) => {
      dock = next && clampDock(next, { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
      if (dock) { el.style.right = `${dock.right}px`; el.style.bottom = `${dock.bottom}px`; el.dataset.docked = ""; }
      else { el.style.removeProperty("right"); el.style.removeProperty("bottom"); delete el.dataset.docked; }
      record();
    };
    place(dock);
    const observer = new ResizeObserver(record);
    observer.observe(el);
    let previousY = window.scrollY;
    let tucked = false;
    const onScroll = () => {
      const y = window.scrollY;
      // A corner the person placed stays where they put it.
      const next = el.dataset.docked === undefined && nextTucked({ tucked, previousY, y, viewport: window.innerHeight, documentHeight: document.documentElement.scrollHeight });
      if (Math.abs(y - previousY) > SCROLL_STEP || next !== tucked) previousY = y;
      if (next !== tucked) { tucked = next; if (next) el.dataset.tucked = ""; else delete el.dataset.tucked; }
    };
    let drag: { id: number; x: number; y: number; from: Dock; moved: boolean } | undefined;
    let swallowClick = false;
    const onDown = (event: PointerEvent) => {
      const handle = (event.target as HTMLElement | null)?.closest("[data-drag-handle]");
      if (!handle || event.button !== 0) return;
      const box = el.getBoundingClientRect();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, from: { right: window.innerWidth - box.right, bottom: window.innerHeight - box.bottom }, moved: false };
    };
    const onMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!drag.moved) { drag.moved = true; el.dataset.dragging = ""; delete el.dataset.tucked; tucked = false; }
      place({ right: drag.from.right - dx, bottom: drag.from.bottom - dy });
    };
    const onUp = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      if (drag.moved) {
        swallowClick = true;
        delete el.dataset.dragging;
        try { if (dock) window.localStorage.setItem(DOCK_KEY, JSON.stringify(dock)); } catch { /* not remembered: still placed */ }
      }
      drag = undefined;
    };
    // The click that ends a drag does not open the panel.
    const onClick = (event: MouseEvent) => { if (swallowClick) { swallowClick = false; event.preventDefault(); event.stopPropagation(); } };
    const onResize = () => { if (dock) place(dock); else record(); };
    el.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    el.addEventListener("click", onClick, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      el.removeEventListener("click", onClick, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);
  return <div ref={ref} className="corner-stack">{children}</div>;
}
