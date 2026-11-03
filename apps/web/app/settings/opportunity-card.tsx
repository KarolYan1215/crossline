"use client";

import { useState } from "react";
import { useLocale, useT } from "../locale-context";
import type { WatchView } from "../milestones/line-watches";
import { postWatch } from "../milestones/line-watches";
import { shortDay } from "../asks/model";

export type LessView = { id: string; at: string; title: string; reason?: string; note?: string; changes: string[]; undone: boolean };
export type OpportunitySettingsView = { watches: WatchView[]; retired: WatchView[]; weekCost: number; exploreShare: number;
  scout: { runs: number; cost: number; lastRunAt?: string }; less: LessView[]; badTimes: string[]; knownHosts: string[] };

const STATE_LABEL = { proposed: "待定", active: "运行中", paused: "已暂停", retired: "已关闭" } as const;
const ORIGIN_LABEL = { derived: "系统推导", migrated: "系统推导", scout: "侦察提议", person: "本人" } as const;
/** Weighted tokens as the person reads them. */
const tokens = (value: number) => value >= 10_000 ? `${Math.round(value / 1000)}k` : String(value);

export async function undoLessEntry(id: string): Promise<boolean> {
  const response = await fetch("/api/opportunities/less", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) }).catch(() => null);
  return Boolean(response?.ok);
}

/** One 「少来」 adjustment with what it changed and 撤销 (shared with the weekly review's 视野外). */
export function LessList({ entries }: { entries: LessView[] }) {
  const t = useT(), locale = useLocale();
  const [problem, setProblem] = useState("");
  if (!entries.length) return <p className="muted">{t("还没有「少来」的调整。")}</p>;
  return <>
    <ul className="op-less">{entries.map((entry) => <li key={entry.id} data-undone={entry.undone || undefined}>
      <p><b>{entry.title}</b> <small className="muted">{shortDay(entry.at.slice(0, 10), locale)}{entry.reason ? ` · ${entry.reason}` : ""}</small></p>
      {entry.note && <small>{entry.note}</small>}
      <small className="muted">{entry.changes.join(t("；"))}</small>
      {entry.undone ? <small className="muted">{t("已撤销")}</small>
        : <button type="button" onClick={() => void undoLessEntry(entry.id).then((ok) => ok ? location.reload() : setProblem(t("没能撤销，请稍后重试")))}>{t("撤销")}</button>}
    </li>)}</ul>
    {problem && <small role="alert">{problem}</small>}
  </>;
}

/**
 * Settings → 机会代理 (docs/opportunity-agent.md §17.9): every watch with how often it runs, what it cost and produced; this week's cost
 * and the exploration share (at most 20% of the opportunity agent's spend); retired watches to restore; and every 「少来」 adjustment,
 * undoable. The machine owner's only.
 */
export function OpportunityCard({ view }: { view: OpportunitySettingsView }) {
  const t = useT(), locale = useLocale();
  const [problem, setProblem] = useState("");
  const act = async (body: Record<string, unknown>) => {
    const result = await postWatch(body);
    if (result.ok) location.reload(); else setProblem(t("没能保存，请稍后重试"));
  };
  return <section className="st-card" aria-label={t("机会代理")}>
    <p className="op-summary">{t("本周花费 {{cost}} 加权 token，其中探索占 {{share}}%（上限 20%）。每周侦察跑过 {{runs}} 次{{last}}。", {
      cost: tokens(view.weekCost), share: Math.round(view.exploreShare * 100), runs: view.scout.runs,
      last: view.scout.lastRunAt ? t("，上次 {{day}}", { day: shortDay(view.scout.lastRunAt.slice(0, 10), locale) }) : "" })}</p>
    <div className="op-table-wrap">
      <table className="op-table">
        <thead><tr><th>{t("监视项")}</th><th>{t("状态")}</th><th>{t("周期")}</th><th>{t("跑过")}</th><th>{t("推给本人")}</th><th>{t("花费")}</th><th>{t("产出")}</th><th /></tr></thead>
        <tbody>{view.watches.map((watch) => <tr key={watch.id}>
          <td><b>{watch.title}</b><small className="muted">{t(ORIGIN_LABEL[watch.origin])}{watch.explore ? ` · ${t("探索")}` : ""}</small></td>
          <td>{t(STATE_LABEL[watch.state])}</td>
          <td className="mono">{t("{{n}} 天", { n: watch.everyDays })}</td>
          <td className="mono">{watch.runs}</td>
          <td className="mono">{watch.surfaced}</td>
          <td className="mono">{tokens(watch.cost)}</td>
          <td className="mono">{watch.yield}</td>
          <td>{watch.state === "active" ? <button type="button" onClick={() => void act({ action: "state", id: watch.id, state: "paused" })}>{t("暂停")}</button>
            : watch.state === "paused" ? <button type="button" onClick={() => void act({ action: "state", id: watch.id, state: "active" })}>{t("恢复")}</button>
            : <button type="button" onClick={() => void act({ action: "decide", id: watch.id, decision: "active" })}>{t("盯住")}</button>}
            {" "}<button type="button" onClick={() => void act(watch.state === "proposed" ? { action: "decide", id: watch.id, decision: "retired" } : { action: "state", id: watch.id, state: "retired" })}>{t("关闭")}</button></td>
        </tr>)}</tbody>
      </table>
    </div>
    {view.retired.length > 0 && <details><summary>{t("已关闭的 {{n}} 个监视项", { n: view.retired.length })}</summary>
      <ul className="op-retired">{view.retired.map((watch) => <li key={watch.id}>
        <b>{watch.title}</b> <small className="muted">{watch.retiredBy === "system" ? t("长期没有产出，系统关闭") : t("本人关闭")}</small>
        <button type="button" onClick={() => void act({ action: "state", id: watch.id, state: "active" })}>{t("恢复")}</button>
      </li>)}</ul>
    </details>}
    <h3>{t("少来的调整")}</h3>
    {(view.badTimes.length > 0 || view.knownHosts.length > 0) && <p className="muted">{[
      view.badTimes.length ? t("不合适的时间：{{items}}", { items: view.badTimes.join(t("、")) }) : "",
      view.knownHosts.length ? t("已知道的来源：{{items}}", { items: view.knownHosts.join(t("、")) }) : ""].filter(Boolean).join(t("；"))}</p>}
    <LessList entries={view.less} />
    {problem && <small role="alert">{problem}</small>}
  </section>;
}
