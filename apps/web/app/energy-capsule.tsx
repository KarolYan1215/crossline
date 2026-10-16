"use client";

import { useState } from "react";
import { EnergyProbe } from "./energy-probe";
import type { DashboardData } from "./dashboard-view";
import { useLocale, useT } from "./locale-context";

const LEVEL = { low: "低", medium: "中", high: "高" } as const;
const SURE = { low: "把握低", medium: "把握中", high: "把握高" } as const;

/**
 * Today's energy in one place (docs/energy-and-ecosystem.md §3.4, decided 2026-10-14): the model's reading of now — the one the
 * schedule uses — with the first lines of its basis, or the person's own word from the last four hours. It asks nothing: a tap opens the
 * three levels, and the answer is a self-report with `context: "correction"` that recalibrates the model. It replaced the always-visible
 * L/M/H probe, so the head holds one control instead of three.
 */
export function EnergyCapsule({ estimate }: { estimate: NonNullable<DashboardData["energyEstimate"]> }) {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const own = estimate.selfReport;
  const reading = own ? t("{{level}}（本人自评）", { level: t(LEVEL[own]) }) : `${t(LEVEL[estimate.level])} · ${t(SURE[estimate.confidence])}`;
  const basis = own ? [] : estimate.basis.slice(0, 2);
  return <div className="energy-capsule" data-testid="energy-capsule">
    <button type="button" className="energy-capsule-button" aria-expanded={open} onClick={() => setOpen((value) => !value)}
      title={[...estimate.basis, ...(estimate.capacity?.basis ?? [])].join(locale === "en" ? "; " : "；")}>
      <small>{t("精力")}</small><b>{reading}</b>
    </button>
    {basis.length > 0 && <span className="energy-capsule-basis">{basis.join(" · ")}</span>}
    {estimate.capacity && <span className="energy-capsule-basis">{t("今天无截止的工作按 {{pct}}% 安排：{{basis}}", { pct: Math.round(estimate.capacity.multiplier * 100),
      basis: estimate.capacity.basis.join(locale === "en" ? ", " : "、") })}</span>}
    {open && <span className="energy-capsule-correct"><span>{t("实际精力")}</span><EnergyProbe context="correction" /></span>}
  </div>;
}
