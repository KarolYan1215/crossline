"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FamiliarityLevel } from "@crossline/core";
import { useT } from "../locale-context";

/**
 * How much this task is explained (walkthrough W-154): 「熟悉领域·从简」 or 「新领域·附讲解」, with the other choice one click away. The
 * choice is kept for the line and kind of work (`tasks.familiarity`), so later tasks of the kind follow it.
 */
export const FAMILIARITY_TAG: Record<FamiliarityLevel, string> = { near: "熟悉领域·从简", mid: "一般熟悉·按步骤", far: "新领域·附讲解" };
const SWITCH_TO: Record<FamiliarityLevel, FamiliarityLevel[]> = { near: ["far"], mid: ["near", "far"], far: ["near"] };
const SWITCH_LABEL: Record<FamiliarityLevel, string> = { near: "改为熟悉", mid: "改为一般", far: "改为新领域" };

export function FamiliarityTag({ workOrderId, level, by }: { workOrderId: string; level: FamiliarityLevel; by: "person" | "rules" }) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const choose = async (next: FamiliarityLevel) => {
    setBusy(true);
    try {
      const response = await fetch(`/api/work-orders/${encodeURIComponent(workOrderId)}/familiarity`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ level: next }) });
      if (response.ok) router.refresh();
    } finally { setBusy(false); }
  };
  return <span className="task-familiarity" data-level={level}>
    <span className="ui-tag" title={by === "person" ? t("本人设定，同一主线的同类任务都按此准备") : t("按本人的背景和做过的同类任务判断")}>{t(FAMILIARITY_TAG[level])}</span>
    {SWITCH_TO[level].map((next) => <button key={next} type="button" className="link-button" disabled={busy} onClick={() => void choose(next)}>{t(SWITCH_LABEL[next])}</button>)}
  </span>;
}
