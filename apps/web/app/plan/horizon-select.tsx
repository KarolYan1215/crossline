"use client";

import { useState } from "react";
import type { Horizon, HorizonChoice } from "../../lib/plan-stats";
import { SegmentedControl } from "../ui/controls";
import { md } from "./chart-geometry";
import { useT } from "../locale-context";

/** How far the charts look: four or eight weeks, or to the farthest approved deadline (at most six months). Kept in the address. */
export function HorizonSelect({ horizon }: { horizon: Horizon }) {
  const t = useT();
  const [pending, setPending] = useState(false);
  const options: Array<{ value: HorizonChoice; label: string; title?: string }> = [{ value: "4", label: t("{{count}} 周", { count: 4 }) }, { value: "8", label: t("{{count}} 周", { count: 8 }) }];
  if (horizon.farthest) options.push({ value: "far", label: t("到最远截止 · {{day}}", { day: md(horizon.farthest) }),
    title: horizon.capped ? t("最远截止 {{day}}，超过 6 个月，图表只显示前 6 个月", { day: horizon.farthest }) : t("到 {{day}}", { day: horizon.farthest }) });
  return <div className="pl-horizon">
    <SegmentedControl label={t("统计范围")} value={horizon.choice} options={options} disabled={pending}
      onChange={(value) => { setPending(true); window.location.assign(value === "8" ? "/plan" : `/plan?horizon=${value}`); }} />
    {pending ? <small role="status">{t("计算中…")}</small> : horizon.capped ? <small>{t("只显示前 6 个月")}</small> : null}
  </div>;
}
