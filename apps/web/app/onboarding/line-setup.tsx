"use client";

import { useState } from "react";

type Draft = { label: string; ranked: boolean; hard: boolean };

const TIPS = [
  "主线写成身份名词：「研究者」「工程师」「创作者」「投资者」，而不是「科研」「工作」这类领域名。",
  "只列正在投入或明确想投入的主线，2–5 条为宜；宽泛的生活角色不单列，它们会在访谈中作为约束出现。",
  "排序代表未来 12–24 个月的主次：第一条是不能动摇的底座。没有排序的主线彼此平行。",
  "硬约束（最多两条）：有固定日程且必须优先的身份，例如有课表的学生、坐班的职员。日历以它为骨架排程，可用时段由它推出；没有硬约束则完全按设定的工作时间安排。"
];

/**
 * The first screen of the interview (decided 2026-10-08): the person names the lines their life runs on, orders them for the next
 * 12–24 months (or leaves some in parallel) and marks up to two hard constraints — a structure to choose and describe, not something to
 * be inferred from a conversation. The conversation that follows gives each line its description and long-term goals.
 */
export function LineSetup({ onDone }: { onDone: () => void }) {
  const [lines, setLines] = useState<Draft[]>([{ label: "", ranked: true, hard: false }]);
  const [dragging, setDragging] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const update = (index: number, change: Partial<Draft>) => setLines((list) => list.map((line, i) => i === index ? { ...line, ...change } : line));
  const hardCount = lines.filter((line) => line.hard).length;
  const move = (from: number, to: number) => setLines((list) => { const next = [...list]; const [item] = next.splice(from, 1); next.splice(to, 0, item!); return next; });
  const save = async () => {
    setStatus("保存中…");
    const response = await fetch("/api/lines", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ setup: lines.filter((line) => line.label.trim()) }) }).catch(() => null);
    const body = await response?.json().catch(() => null) as { code?: string } | null;
    if (response?.ok) { onDone(); return; }
    setStatus(body?.code === "LINE_LABEL_TAKEN" ? "有重复的主线名称" : body?.code === "LINE_HARD_LIMIT" ? "硬约束最多两条" : "需要至少一条主线");
  };
  const ranked = lines.filter((line) => line.ranked).length;
  return <section className="ob-setup" aria-label="设定主线">
    <header><h2>先设定主线</h2><p className="muted">访谈会围绕这些主线展开，为每条写出个性化描述与长期目标（成为 ___ 的 <i>身份</i>）。</p></header>
    <ul className="ob-tips">{TIPS.map((tip) => <li key={tip}>{tip}</li>)}</ul>
    <ol className="ob-setup-lines">
      {lines.map((line, index) => <li key={index} draggable onDragStart={() => setDragging(index)} onDragOver={(event) => event.preventDefault()}
        onDrop={() => { if (dragging !== null && dragging !== index) move(dragging, index); setDragging(null); }} data-ranked={line.ranked || undefined}>
        <span className="ob-grip" aria-hidden="true">⋮⋮</span>
        <span className="ob-rank mono">{line.ranked ? lines.slice(0, index + 1).filter((item) => item.ranked).length === 1 ? "底座" : `第 ${lines.slice(0, index + 1).filter((item) => item.ranked).length}` : "平行"}</span>
        <input value={line.label} maxLength={20} placeholder="身份名词，例如：研究者" aria-label={`主线 ${index + 1}`} onChange={(event) => update(index, { label: event.target.value })} />
        <label><input type="checkbox" checked={line.ranked} onChange={(event) => update(index, { ranked: event.target.checked })} /> 参与主次</label>
        <label title="固定日程为骨架、截止优先、可用时段由它推出"><input type="checkbox" checked={line.hard} disabled={!line.hard && hardCount >= 2}
          onChange={(event) => update(index, { hard: event.target.checked })} /> 硬约束</label>
        {lines.length > 1 && <button type="button" aria-label="删除该主线" onClick={() => setLines((list) => list.filter((_, i) => i !== index))}>×</button>}
      </li>)}
    </ol>
    <div className="ob-setup-actions">
      <button type="button" onClick={() => setLines((list) => [...list, { label: "", ranked: false, hard: false }])}>＋ 添加主线</button>
      <span className="muted">{ranked ? `${ranked} 条参与主次，拖动调整顺序` : "全部平行"}{hardCount ? ` · ${hardCount} 条硬约束` : " · 无硬约束：按工作时间自由安排"}</span>
      <button type="button" className="primary-button" disabled={!lines.some((line) => line.label.trim())} onClick={() => void save()}>开始访谈</button>
      {status && <small role="status">{status}</small>}
    </div>
  </section>;
}
