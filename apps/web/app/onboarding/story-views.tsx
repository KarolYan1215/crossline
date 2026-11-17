"use client";

import { useT } from "../locale-context";
import type { Hypothesis } from "./interview-contract";

/**
 * The right column's pictures added after replay 15 (2026-11-15, docs/onboarding-agent-session.md 「第十五次之后的改造」 step 5): the
 * hypotheses as a board by where the evidence left them, the life story as a line, the loop that keeps things as they are, and the
 * cards' readings handed back to the person. Each draws only what the record holds and says so plainly when it holds nothing yet.
 */

/** The hypothesis log by where the evidence left it: supported, still open (`open` and `undecided`), refuted. */
export function boardColumns(hypotheses: readonly Hypothesis[] | undefined): Record<"supported" | "pending" | "refuted", Hypothesis[]> {
  const all = hypotheses ?? [];
  return { supported: all.filter((item) => item.status === "supported"), pending: all.filter((item) => item.status === "open" || item.status === "undecided"),
    refuted: all.filter((item) => item.status === "refuted") };
}

const COLUMNS = [{ key: "supported", label: "已支持" }, { key: "pending", label: "待定" }, { key: "refuted", label: "已推翻" }] as const;

export function HypothesisBoard({ hypotheses, onOpen }: { hypotheses: readonly Hypothesis[] | undefined; onOpen: (id: string) => void }) {
  const t = useT();
  const columns = boardColumns(hypotheses);
  if (!(hypotheses ?? []).length) return null;
  return <section className="ob-board" aria-label={t("假设看板")}>
    {COLUMNS.map((column) => <div key={column.key} className="ob-board-column" data-column={column.key}>
      <b>{t(column.label)}<small>{columns[column.key].length}</small></b>
      <ul>{columns[column.key].map((item) => <li key={item.id}>
        <button type="button" className="gen" onClick={() => onOpen(item.id)}>{item.statement}</button><small>{item.dimension}</small>
      </li>)}</ul>
    </div>)}
  </section>;
}

/** The life story (D8): the theme, the turns in the order the record keeps them, and the next chapter as the person tells it. */
export function LifelineView({ theme, turns, next }: { theme?: string | undefined; turns?: readonly string[] | undefined; next?: string | undefined }) {
  const t = useT();
  const points = (turns ?? []).filter((turn) => turn.trim());
  if (!points.length && !next?.trim()) return <p className="ob-muted">{t("经历部分谈到的转折会画在这里。")}</p>;
  return <section className="ob-lifeline" aria-label={t("生命线")}>
    <b>{t("生命线")}</b>
    {theme?.trim() && <p className="gen">{theme}</p>}
    <ol>{points.map((turn, index) => <li key={index} className="gen">{turn}</li>)}
      {next?.trim() && <li data-next><small>{t("下一章")}</small><span className="gen">{next}</span></li>}</ol>
  </section>;
}

/** Where a loop's nodes sit on its circle, the first at the top, clockwise. */
export function loopPoints(count: number, size = 200, radius = 70): Array<{ x: number; y: number }> {
  return Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / count;
    return { x: Math.round(size / 2 + radius * Math.cos(angle)), y: Math.round(size / 2 + radius * Math.sin(angle)) };
  });
}

/**
 * The maintenance loop (D9): the hypotheses of that dimension the evidence has not refuted, as steps round a circle, each leading to the
 * next and the last back to the first. Checked with the person at the close; until then it says what will be drawn here.
 */
export function LoopView({ hypotheses }: { hypotheses: readonly Hypothesis[] | undefined }) {
  const t = useT();
  const steps = (hypotheses ?? []).filter((item) => item.dimension === "D9" && item.status !== "refuted");
  if (steps.length < 2) return <p className="ob-muted">{t("收尾时和你核对的维持循环会画在这里。")}</p>;
  const points = loopPoints(steps.length);
  return <section className="ob-loop" aria-label={t("维持循环")}>
    <b>{t("维持循环")}</b>
    <svg viewBox="0 0 200 200" className="ob-loop-svg" aria-hidden="true">
      <defs><marker id="ob-loop-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L8,4 L0,8 z" /></marker></defs>
      <circle cx={100} cy={100} r={70} className="ob-loop-ring" />
      {points.map((point, index) => { const to = points[(index + 1) % points.length]!;
        const x = point.x + (to.x - point.x) * 0.2, y = point.y + (to.y - point.y) * 0.2, x2 = point.x + (to.x - point.x) * 0.8, y2 = point.y + (to.y - point.y) * 0.8;
        return <line key={`e${index}`} x1={x} y1={y} x2={x2} y2={y2} markerEnd="url(#ob-loop-arrow)" />; })}
      {points.map((point, index) => <g key={`n${index}`}><circle cx={point.x} cy={point.y} r={11} /><text x={point.x} y={point.y + 4} textAnchor="middle">{index + 1}</text></g>)}
    </svg>
    <ol>{steps.map((step) => <li key={step.id} className="gen">{step.statement}</li>)}</ol>
    <small>{t("最后一步又回到第一步。")}</small>
  </section>;
}

/** The cards' readings handed back (2026-11-15): a level in words per scored dimension, never the number. */
export function ScaleReadings({ readings }: { readings: ReadonlyArray<{ label: string; level: string }> | undefined }) {
  const t = useT();
  if (!readings?.length) return null;
  return <section className="ob-readings" aria-label={t("量表读数")}>
    <b>{t("量表读数")}</b><small>{t("读出来的是倾向，不是分数；对话里会说它在你的日子里怎么表现。")}</small>
    <ul>{readings.map((reading) => <li key={reading.label}><span>{t(reading.label)}</span><small>{t(reading.level)}</small></li>)}</ul>
  </section>;
}
