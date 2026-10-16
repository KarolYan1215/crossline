"use client";

import { useState } from "react";
import { SegmentedControl } from "../ui/controls";
import { LineTag, Tag } from "../ui/tag";
import { useT } from "../locale-context";

type Row = { id: string; source: string; sourceLabel: string; scopeLabel: string; line?: string; text: string; day: string };
type Period = "off" | "biweekly" | "monthly";
const post = (body: unknown) => fetch("/api/preferences", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then((response) => response.ok).catch(() => false);

/**
 * 个性化: everything the system has learned about how this person works — corrections told to 小帮手, milestone retrospectives,
 * estimates and importance changed by hand, standards confirmed by hand, relations turned down — each removable, plus how often
 * new task archetypes are drawn from the accumulated history.
 */
export function PersonalizationModule({ rows, period, learned }: { rows: Row[]; period: Period; learned: Array<{ id: string; label: string; source: string }> }) {
  const t = useT();
  const [list, setList] = useState(rows);
  const [archetypes, setArchetypes] = useState(learned);
  const [cadence, setCadence] = useState(period);
  const [note, setNote] = useState("");
  const sources = [...new Set(list.map((row) => row.sourceLabel))];
  // The filter's value is the source label as stored; 「全部」 is its own value, shown translated.
  const ALL = "全部";
  const [filter, setFilter] = useState(ALL);
  const shown = filter === ALL ? list : list.filter((row) => row.sourceLabel === filter);
  return <div className="st-modules">
    <section className="st-card st-card-wide" aria-label={t("已学到的偏好")}>
      <header><h3>{t("已学到的偏好 · {{n}}", { n: list.length })}</h3><small>{t("之后的分析、步骤拆分与里程碑设计都会参考；删除后不再使用")}</small></header>
      {list.length === 0 ? <p className="muted">{t("尚无记录。向小帮手纠正分类或步骤、修改估时与重要性、填写里程碑回顾后，会出现在这里。")}</p> : <>
        {sources.length > 1 && <SegmentedControl label={t("来源")} value={filter} onChange={setFilter}
          options={[ALL, ...sources].map((value) => ({ value, label: t(value) }))} />}
        <ul className="st-prefs">{shown.map((row) => <li key={row.id}>
          <Tag>{t(row.sourceLabel)}</Tag>
          {row.line ? <LineTag line={row.line}>{t(row.scopeLabel)}</LineTag> : <Tag>{t(row.scopeLabel)}</Tag>}
          <span className="st-pref-text">{row.text}</span>
          <small className="mono">{row.day}</small>
          <button type="button" className="st-pref-remove" aria-label={t("删除：{{text}}", { text: row.text })} title={t("删除")} onClick={async () => {
            if (await post({ remove: row.id })) setList((current) => current.filter((item) => item.id !== row.id)); else setNote(t("删除未完成"));
          }}>×</button>
        </li>)}</ul>
      </>}
      {note && <p role="status" className="st-note">{note}</p>}
    </section>
    <section className="st-card" aria-label={t("任务原型扩充")}>
      <header><h3>{t("任务原型扩充")}</h3><small>{t("按积累的任务与偏好检索并归纳新原型，新原型用于之后的步骤拆分")}</small></header>
      <div className="st-row"><span className="st-row-label">{t("周期")}<small>{t("积累满 20 条新偏好时也会提前运行一次")}</small></span>
        <SegmentedControl label={t("原型扩充周期")} value={cadence} onChange={async (next) => {
          const previous = cadence; setCadence(next);
          if (!await post({ period: next })) { setCadence(previous); setNote(t("未保存")); }
        }} options={[{ value: "off", label: t("关闭", { context: "state" }) }, { value: "biweekly", label: t("每两周") }, { value: "monthly", label: t("每月") }]} /></div>
      <div className="st-row st-row-wrap"><span className="st-row-label">{t("已归纳的原型 · {{n}}", { n: archetypes.length })}<small>{archetypes.length ? t("删除后不再用于步骤拆分") : t("尚未归纳；内置 18 个原型照常使用")}</small></span>
        <span className="st-chips">{archetypes.map((item) => <button key={item.id} type="button" className="st-chip" title={item.source ? t("依据：{{source}}", { source: item.source }) : undefined}
          aria-label={t("删除原型「{{name}}」", { name: item.label })} onClick={async () => {
            if (await post({ retireArchetype: item.id })) setArchetypes((current) => current.filter((entry) => entry.id !== item.id)); else setNote(t("删除未完成"));
          }}>{item.label} ×</button>)}</span></div>
    </section>
  </div>;
}
