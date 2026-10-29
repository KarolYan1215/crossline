"use client";

import { useEffect, useState } from "react";
import { Timer } from "lucide-react";
import type { TaskDetail } from "../../lib/task-detail";
import { ICON } from "../ui/icon-button";
import { useT } from "../locale-context";

/** 「32:10」 / 「1:02:05」 for a count of seconds. */
export function sessionClock(seconds: number): string {
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  return `${h ? `${h}:` : ""}${String(m).padStart(h ? 2 : 1, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * 「计时中 32:10」: the open session's working time (its pauses taken off), counted where the task is shown — the task card and the
 * detail's head; 「已暂停」 while it is paused. The clock starts after mount, so the server's HTML and the first client render agree.
 */
export function RunningChip({ detail }: { detail: Pick<TaskDetail, "executions" | "paused"> }) {
  const t = useT();
  const session = detail.executions.find((item) => !item.endedAt);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!session || detail.paused) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [session, detail.paused]);
  const icon = <Timer {...ICON} size={14} />;
  if (detail.paused) return <span className="task-chip" data-tone="running">{icon}{t("已暂停")}</span>;
  const seconds = session && now !== null ? Math.max(0, Math.round((now - Date.parse(session.startedAt)) / 1000) - session.pauseMinutes * 60) : null;
  return <span className="task-chip" data-tone="running">{icon}{t("计时中")}{seconds !== null && <span className="mono">{sessionClock(seconds)}</span>}</span>;
}
