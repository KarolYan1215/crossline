"use client";

import { useState } from "react";
import type { Horizon, HorizonChoice } from "../../lib/plan-stats";
import { SegmentedControl } from "../ui/controls";
import { md } from "./chart-geometry";

/** How far the charts look: four or eight weeks, or to the farthest approved deadline (at most six months). Kept in the address. */
export function HorizonSelect({ horizon }: { horizon: Horizon }) {
  const [pending, setPending] = useState(false);
  const options: Array<{ value: HorizonChoice; label: string; title?: string }> = [{ value: "4", label: "4 周" }, { value: "8", label: "8 周" }];
  if (horizon.farthest) options.push({ value: "far", label: `到最远截止 · ${md(horizon.farthest)}`,
    title: horizon.capped ? `最远截止 ${horizon.farthest}，超过 6 个月，图表只显示前 6 个月` : `到 ${horizon.farthest}` });
  return <div className="pl-horizon">
    <SegmentedControl label="统计范围" value={horizon.choice} options={options} disabled={pending}
      onChange={(value) => { setPending(true); window.location.assign(value === "8" ? "/plan" : `/plan?horizon=${value}`); }} />
    {pending ? <small role="status">计算中…</small> : horizon.capped ? <small>只显示前 6 个月</small> : null}
  </div>;
}
