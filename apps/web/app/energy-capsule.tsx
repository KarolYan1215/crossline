"use client";

import { useState } from "react";
import { EnergyProbe } from "./energy-probe";
import type { DashboardData } from "./dashboard-view";

const LEVEL = { low: "低", medium: "中", high: "高" } as const;
const SURE = { low: "把握低", medium: "把握中", high: "把握高" } as const;

/**
 * Today's energy in one place (docs/energy-and-ecosystem.md §3.4, decided 2026-10-14): the model's reading of now — the one the
 * schedule uses — with the first lines of its basis, or the person's own word from the last four hours. It asks nothing: a tap opens the
 * three levels, and the answer is a self-report with `context: "correction"` that recalibrates the model. It replaced the always-visible
 * L/M/H probe, so the head holds one control instead of three.
 */
export function EnergyCapsule({ estimate }: { estimate: NonNullable<DashboardData["energyEstimate"]> }) {
  const [open, setOpen] = useState(false);
  const own = estimate.selfReport;
  const reading = own ? `${LEVEL[own]}（本人自评）` : `${LEVEL[estimate.level]} · ${SURE[estimate.confidence]}`;
  const basis = own ? [] : estimate.basis.slice(0, 2);
  return <div className="energy-capsule" data-testid="energy-capsule">
    <button type="button" className="energy-capsule-button" aria-expanded={open} onClick={() => setOpen((value) => !value)}
      title={[...estimate.basis, ...(estimate.capacity?.basis ?? [])].join("；")}>
      <small>精力</small><b>{reading}</b>
    </button>
    {basis.length > 0 && <span className="energy-capsule-basis">{basis.join(" · ")}</span>}
    {estimate.capacity && <span className="energy-capsule-basis">今天无截止的工作按 {Math.round(estimate.capacity.multiplier * 100)}% 安排：{estimate.capacity.basis.join("、")}</span>}
    {open && <span className="energy-capsule-correct"><span>实际精力</span><EnergyProbe context="correction" /></span>}
  </div>;
}
