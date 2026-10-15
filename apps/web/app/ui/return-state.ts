"use client";

import { useEffect, useRef } from "react";

/**
 * Going back to a list restores it as it was left: the scroll position, which folds were open, and whatever a page registers through
 * `useReturnState` (an open dialog, a picked block, a chosen view). Every page in the shared frame saves its snapshot to sessionStorage
 * as the person leaves it (`ReturnPoint` in the frame); a snapshot is read back only when the page is returned to — the browser's own
 * back, or a `BackLink` that marked the page it returns to — never on a fresh visit, so opening 任务 from the menu starts at the top.
 */
const SNAPSHOT = "crossline:return:";
const RETURNING = "crossline:returning";
/** The last page left in this tab, so a detail page knows where it was opened from. */
const LAST = "crossline:last-page";

export type ReturnSnapshot = { scrollY: number; details: Record<string, boolean>; extra: Record<string, unknown> };

const getters = new Map<string, () => unknown>();

export const pageKey = (): string => `${location.pathname}${location.search}`;

const storage = (): Storage | null => { try { return window.sessionStorage; } catch { return null; } };
const read = <T,>(key: string): T | null => { try { const raw = storage()?.getItem(key); return raw ? JSON.parse(raw) as T : null; } catch { return null; } };
const write = (key: string, value: unknown) => { try { storage()?.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ } };

/** Folds are matched by id, else by their summary text without its counts (「任务库 12 项」 and 「任务库 13 项」 are one fold). */
function detailsKeys(root: ParentNode): Array<[string, HTMLDetailsElement]> {
  const seen = new Map<string, number>();
  return [...root.querySelectorAll("details")].map((element) => {
    const base = element.id || (element.querySelector("summary")?.textContent ?? "").replace(/[\d\s·.,/:%-]+/g, "").slice(0, 40);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return [`${base}#${n}`, element];
  });
}

export function takeSnapshot(): ReturnSnapshot {
  const main = document.querySelector("main") ?? document;
  const extra: Record<string, unknown> = {};
  for (const [name, get] of getters) { try { extra[name] = get(); } catch { /* a getter of an unmounting component */ } }
  return { scrollY: Math.round(window.scrollY), details: Object.fromEntries(detailsKeys(main).map(([key, element]) => [key, element.open])), extra };
}

export function saveReturnState(): void {
  write(`${SNAPSHOT}${pageKey()}`, takeSnapshot());
  write(LAST, pageKey());
}

/** The page this tab was on before the current one (as `saveReturnState` last wrote it while leaving). */
export function lastPage(): string | null { return read<string>(LAST); }

/** Marks `path` as being returned to, so its snapshot is restored when it loads. */
export function markReturning(path: string): void { write(RETURNING, path); }

// Asked once per page: the first caller (the frame or a hook, whichever mounts first) takes the returning mark off.
let decided: { key: string; snapshot: ReturnSnapshot | null } | undefined;
const initialKey = typeof window === "undefined" ? "" : pageKey();

/** The snapshot to restore on this page, or null on a fresh visit. */
export function returningSnapshot(): ReturnSnapshot | null {
  const key = pageKey();
  if (decided?.key === key) return decided.snapshot;
  let snapshot: ReturnSnapshot | null = null;
  const marked = read<string>(RETURNING) === key;
  let back = false;
  try { back = key === initialKey && (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type === "back_forward"; }
  catch { back = false; }
  if (marked || back) snapshot = read<ReturnSnapshot>(`${SNAPSHOT}${key}`);
  if (marked) { try { storage()?.removeItem(RETURNING); } catch { /* blocked */ } }
  decided = { key, snapshot };
  return snapshot;
}

/** Applies the frame's part of a snapshot: the folds, then the scroll (again once late content such as charts has laid out). */
export function restoreFrame(snapshot: ReturnSnapshot): void {
  const main = document.querySelector("main") ?? document;
  for (const [key, element] of detailsKeys(main)) { const open = snapshot.details[key]; if (open !== undefined) element.open = open; }
  const scroll = () => window.scrollTo(0, snapshot.scrollY);
  requestAnimationFrame(scroll);
  window.setTimeout(scroll, 250);
}

/**
 * A component's own part of the page state, saved when the page is left and handed back to `restore` when it is returned to.
 * `name` must be unique on the page (「task-dialog:<id>」).
 */
export function useReturnState<T>(name: string, value: T, restore: (value: T) => void): void {
  const latest = useRef(value);
  latest.current = value;
  const restoreRef = useRef(restore);
  restoreRef.current = restore;
  useEffect(() => {
    getters.set(name, () => latest.current);
    const snapshot = returningSnapshot();
    if (snapshot && Object.prototype.hasOwnProperty.call(snapshot.extra, name)) restoreRef.current(snapshot.extra[name] as T);
    return () => { getters.delete(name); };
  }, [name]);
}

/** Forgets what this page decided: a later client-side visit to the same address asks again. Also what tests reset with. */
export function forgetReturnDecision(): void { decided = undefined; }
