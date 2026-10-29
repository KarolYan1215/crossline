import type { ReactNode } from "react";

/**
 * The head of a ritual page in the 2026-10-28 frame (本周承诺, 收工, 周复盘): the title, one line saying which days it is about, and the
 * page's actions at the right. Plain markup, so both the server pages and their client boards can draw it.
 */
export function RitualHead({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return <header className="rd-head">
    <div className="rd-head-text"><h1>{title}</h1>{sub && <p>{sub}</p>}</div>
    {actions && <div className="rd-head-actions">{actions}</div>}
  </header>;
}

/** A number with its unit, as the ritual pages' KPI cells draw it: the figure in the display serif (digits only), the unit small. */
export function Figure({ value, unit, tone }: { value: ReactNode; unit?: string; tone?: "alarm" }) {
  return <b className="rd-figure" data-tone={tone}><span className="ds-serif">{value}</span>{unit && <small>{unit}</small>}</b>;
}
