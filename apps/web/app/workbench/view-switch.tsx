"use client";

import { useEffect, useState, type ReactNode } from "react";

const STORAGE_KEY = "crossline.workbench.view";

/**
 * List vs timeline, the same Notion-style view switch the Plan page's B/C/A tabs already use for its
 * own lenses — just persisted in `localStorage` instead of `useState`, since this choice should still
 * hold the next time the person opens Workbench, not only for the current page load.
 *
 * Both views are handed in fully server-rendered (list) or ready to mount (timeline): this component
 * only ever decides which one is in the DOM, it does not fetch or reshape anything itself.
 */
export function WorkbenchViewSwitch({ list, timeline }: { list: ReactNode; timeline: ReactNode }) {
  const [view, setView] = useState<"list" | "timeline">("list");
  useEffect(() => {
    try { if (localStorage.getItem(STORAGE_KEY) === "timeline") setView("timeline"); } catch { /* ignore */ }
  }, []);
  const choose = (next: "list" | "timeline") => {
    setView(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* per-viewer convenience only */ }
  };
  return <>
    <div className="plan-tabs" role="tablist" aria-label="作业视图">
      <button type="button" role="tab" aria-selected={view === "list"} onClick={() => choose("list")}>列表</button>
      <button type="button" role="tab" aria-selected={view === "timeline"} onClick={() => choose("timeline")}>时间轴</button>
    </div>
    {view === "list" ? list : timeline}
  </>;
}
