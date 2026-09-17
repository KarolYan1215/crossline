"use client";
import { useState } from "react";

export type Window = { days: number[]; start: string; end: string; energy: "low" | "medium" | "high" };

const DAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];
const ENERGY_LABELS: Record<Window["energy"], string> = { low: "低", medium: "中", high: "高" };
const codes: Record<string, string> = {
  AVAILABILITY_ENDS_BEFORE_IT_STARTS: "结束时间早于开始时间。",
  AVAILABILITY_INVALID: "时间段填得不完整；星期、起止时间和精力档都要有。"
};

/**
 * When the person is free, which is the input the scheduler never had.
 *
 * `planSchedule` sat unused for exactly this reason: nothing in the app knew this, so the plan showed
 * example blocks instead. Editing it here rewrites the plan on the next load — the schedule is derived
 * on read, never stored, so it cannot drift from the work orders it came from.
 */
export function AvailabilityEditor({ windows }: { windows: Window[] }) {
  const [draft, setDraft] = useState<Window[]>(windows);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const update = (index: number, patch: Partial<Window>) =>
    setDraft(draft.map((window, at) => at === index ? { ...window, ...patch } : window));
  const toggleDay = (index: number, day: number) => {
    const current = draft[index]!.days;
    update(index, { days: current.includes(day) ? current.filter((item) => item !== day) : [...current, day].sort() });
  };

  const save = async () => {
    setBusy(true);
    setStatus("");
    const response = await fetch("/api/settings/availability", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ windows: draft })
    }).catch(() => undefined);
    if (response?.ok) { location.reload(); return; }
    const failure = await response?.json().catch(() => ({})) as { code?: string } | undefined;
    setStatus(codes[failure?.code ?? ""] ?? "没能保存，请刷新后重试。");
    setBusy(false);
  };

  return <details className="availability-editor">
    <summary>可用时间 · {draft.length} 段</summary>
    <p className="review-note">排程只会把作业放进这些时间段里，并且会先扣掉日历上已经占掉的部分。</p>
    {draft.map((window, index) => <div className="availability-row" key={index}>
      <span className="availability-days">{DAY_LABELS.map((label, day) =>
        <button type="button" key={day} aria-pressed={window.days.includes(day)}
          onClick={() => toggleDay(index, day)}>{label}</button>)}</span>
      <label><span className="sr-only">开始</span>
        <input type="time" value={window.start} onChange={(event) => update(index, { start: event.target.value })} /></label>
      <label><span className="sr-only">结束</span>
        <input type="time" value={window.end} onChange={(event) => update(index, { end: event.target.value })} /></label>
      <label><span className="sr-only">精力档</span>
        <select value={window.energy} onChange={(event) => update(index, { energy: event.target.value as Window["energy"] })}>
          {(["low", "medium", "high"] as const).map((level) =>
            <option key={level} value={level}>{ENERGY_LABELS[level]}</option>)}
        </select></label>
      <button type="button" onClick={() => setDraft(draft.filter((_, at) => at !== index))}>删除</button>
    </div>)}
    <div className="availability-actions">
      <button type="button" onClick={() => setDraft([...draft, { days: [1, 2, 3, 4, 5], start: "09:00", end: "12:00", energy: "medium" }])}>
        加一段
      </button>
      <button type="button" className="primary-button" disabled={busy} onClick={() => void save()}>
        {busy ? "保存中…" : "保存并重排"}
      </button>
    </div>
    {status && <p role="status">{status}</p>}
  </details>;
}
