"use client";

import { useState } from "react";
import { useT } from "../locale-context";

/**
 * A line's watches on its card (docs/opportunity-agent.md §17.9): what the opportunity agent keeps looking at for this line, how often and
 * what it produced, each one paused, turned off or edited in place, and one of the person's own added. Shown only in the machine owner's
 * workspace (the page passes none elsewhere).
 */
export type WatchView = { id: string; lineId: string; title: string; why: string; query: string; judge: string; where: string;
  origin: "derived" | "migrated" | "scout" | "person"; explore: boolean; state: "proposed" | "active" | "paused" | "retired"; everyDays: number;
  runs: number; surfaced: number; yield: number; cost: number; lastRunAt?: string; lastYieldAt?: string; retiredBy?: "person" | "system" };

const STATE_LABEL = { proposed: "待定", active: "运行中", paused: "已暂停", retired: "已关闭" } as const;
const ORIGIN_LABEL = { derived: "系统推导", migrated: "系统推导", scout: "侦察提议", person: "本人" } as const;

export async function postWatch(body: Record<string, unknown>): Promise<{ ok: boolean; code?: string }> {
  const response = await fetch("/api/opportunities/watches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  return (await response?.json().catch(() => null) as { ok: boolean; code?: string } | null) ?? { ok: false, code: "NETWORK" };
}

function WatchEditor({ watch, onDone }: { watch: WatchView; onDone: () => void }) {
  const t = useT();
  const [title, setTitle] = useState(watch.title);
  const [query, setQuery] = useState(watch.query);
  const [everyDays, setEveryDays] = useState(watch.everyDays);
  const [problem, setProblem] = useState("");
  const save = async () => {
    const result = await postWatch({ action: "edit", id: watch.id, title, query, everyDays });
    if (result.ok) location.reload(); else setProblem(t("没能保存，请稍后重试"));
  };
  return <div className="lw-edit">
    <label>{t("名称")}<input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} /></label>
    <label>{t("看什么、在哪看")}<textarea rows={2} value={query} maxLength={600} onChange={(event) => setQuery(event.target.value)} /></label>
    <label>{t("每几天看一次")}<input type="number" min={1} max={180} value={everyDays} onChange={(event) => setEveryDays(Number(event.target.value) || 1)} /></label>
    <small className="muted">{t("改过的监视项归本人，系统不会自动关闭。写进网址会按网页变化来看。")}</small>
    <p className="lw-actions"><button type="button" className="btn-primary" onClick={() => void save()}>{t("保存")}</button>
      <button type="button" onClick={onDone}>{t("取消")}</button></p>
    {problem && <small role="alert">{problem}</small>}
  </div>;
}

export function LineWatches({ lineId, watches }: { lineId: string; watches: WatchView[] }) {
  const t = useT();
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [query, setQuery] = useState("");
  const [problem, setProblem] = useState("");
  const act = async (body: Record<string, unknown>) => {
    const result = await postWatch(body);
    if (result.ok) location.reload(); else setProblem(t("没能保存，请稍后重试"));
  };
  return <div className="lw">
    {watches.length === 0 && <p className="muted">{t("这条线还没有监视项。")}</p>}
    <ul className="lw-list">
      {watches.map((watch) => <li key={watch.id} data-state={watch.state}>
        <p className="lw-head"><b>{watch.title}</b>
          <span className="tag">{t(STATE_LABEL[watch.state])}</span>
          <span className="tag">{t(ORIGIN_LABEL[watch.origin])}</span>
          {watch.explore && <span className="tag">{t("探索")}</span>}</p>
        <small className="muted">{t("每 {{days}} 天 · 跑过 {{runs}} 次 · 推给本人 {{surfaced}} 条", { days: watch.everyDays, runs: watch.runs, surfaced: watch.surfaced })}</small>
        <small className="muted lw-where" title={watch.why}>{watch.where}</small>
        {editing === watch.id ? <WatchEditor watch={watch} onDone={() => setEditing(null)} />
          : <p className="lw-actions">
            {watch.state === "proposed" && <button type="button" onClick={() => void act({ action: "decide", id: watch.id, decision: "active" })}>{t("盯住")}</button>}
            {watch.state === "active" && <button type="button" onClick={() => void act({ action: "state", id: watch.id, state: "paused" })}>{t("暂停")}</button>}
            {watch.state === "paused" && <button type="button" onClick={() => void act({ action: "state", id: watch.id, state: "active" })}>{t("恢复")}</button>}
            <button type="button" onClick={() => setEditing(watch.id)}>{t("修改")}</button>
            <button type="button" onClick={() => void act(watch.state === "proposed" ? { action: "decide", id: watch.id, decision: "retired" } : { action: "state", id: watch.id, state: "retired" })}>{t("关闭")}</button>
          </p>}
      </li>)}
    </ul>
    {adding ? <div className="lw-edit">
      <label>{t("名称")}<input value={title} maxLength={120} placeholder={t("例：城市播客线下活动")} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>{t("看什么、在哪看")}<textarea rows={2} value={query} maxLength={600} placeholder={t("一句话，或一个网址")} onChange={(event) => setQuery(event.target.value)} /></label>
      <p className="lw-actions"><button type="button" className="btn-primary" disabled={!title.trim() || !query.trim()}
        onClick={() => void act({ action: "add", lineId, title, query })}>{t("添加")}</button>
        <button type="button" onClick={() => setAdding(false)}>{t("取消")}</button></p>
    </div> : <button type="button" className="lw-add" onClick={() => setAdding(true)}>{t("＋ 添加监视项")}</button>}
    {problem && <small role="alert">{problem}</small>}
  </div>;
}
