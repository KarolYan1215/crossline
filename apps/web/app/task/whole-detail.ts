"use client";

import { useEffect, useState } from "react";
import type { TaskDetail } from "../../lib/task-detail";

/**
 * A card from a list page carries only what the card shows (`cardView`): the whole detail is read when something that needs it opens
 * (the task dialog, the completion sheet), and again when the page hands the card a newer copy (after an action refreshed the page).
 * A whole detail is used as it is.
 */
export function useWholeDetail(detail: TaskDetail, open: boolean): TaskDetail | "failed" | undefined {
  const [loaded, setLoaded] = useState<{ from: TaskDetail; value: TaskDetail | "failed" }>();
  useEffect(() => {
    if (!detail.partial || !open || loaded?.from === detail) return;
    let live = true;
    void fetch(`/api/work-orders/${encodeURIComponent(detail.id)}/detail`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ detail: TaskDetail }> : Promise.reject(new Error(String(response.status))))
      .then((body) => { if (live) setLoaded({ from: detail, value: body.detail }); })
      .catch(() => { if (live) setLoaded({ from: detail, value: "failed" }); });
    return () => { live = false; };
  }, [detail, open, loaded]);
  if (!detail.partial) return detail;
  return loaded?.from === detail ? loaded.value : undefined;
}
