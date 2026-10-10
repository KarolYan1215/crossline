"use client";

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { ForecastCharts } from "../../lib/plan-stats";
import { useImpact } from "../task/impact";

type Preview = { owner: string; before: ForecastCharts; after: ForecastCharts };
type PlanPreview = { horizonDays: number; preview: Preview | null; setPreview: (owner: string, next: Preview | null) => void };

const Context = createContext<PlanPreview>({ horizonDays: 56, preview: null, setPreview: () => undefined });

/**
 * Shared by the plan page's charts and its settings (decided 2026-10-10): while a change is being previewed at the bottom of the page,
 * the charts at the top draw the after-state, with the current values as ghosts.
 */
export function PlanPreviewProvider({ horizonDays, children }: { horizonDays: number; children: ReactNode }) {
  const [preview, set] = useState<Preview | null>(null);
  // Stable, so the hooks below can depend on it without re-running each time the preview changes.
  const setPreview = useCallback((owner: string, next: Preview | null) =>
    set((current) => next ? next : current?.owner === owner ? null : current), []);
  const value = useMemo<PlanPreview>(() => ({ horizonDays, preview, setPreview }), [horizonDays, preview, setPreview]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** The preview the charts should show, if one is open. */
export const usePlanPreview = () => useContext(Context).preview;

/** `useImpact` for the plan page: it asks for the charts too, and hands an open preview to them. */
export function usePlanImpact() {
  const { horizonDays, setPreview } = useContext(Context);
  const owner = useId();
  const impact = useImpact({ charts: horizonDays });
  const charts = impact.pending?.impact.charts;
  useEffect(() => {
    setPreview(owner, charts ? { owner, before: charts.before, after: charts.after } : null);
  }, [charts, owner, setPreview]);
  useEffect(() => () => setPreview(owner, null), [owner, setPreview]);
  return impact;
}
