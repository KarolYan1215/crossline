"use client";
import { useEffect, useState } from "react";
import type { Window } from "./availability-editor";

const DAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];
type MilestoneOption = { id: string; title: string };

export function ScheduleSetup({ windows, milestones }: {
  windows: Window[]; milestones: MilestoneOption[]
}) {
  const [timeZone, setTimeZone] = useState("America/Chicago");
  const [mode, setMode] = useState<"buffered" | "asap">("buffered");
  const [draft, setDraft] = useState(windows);
  const [importance, setImportance] = useState<Record<string, "important" | "ordinary">>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago"); }, []);
  const update = (index: number, patch: Partial<Window>) =>
    setDraft(draft.map((window, at) => at === index ? { ...window, ...patch } : window));

  const submit = async () => {
    setBusy(true); setError("");
    const response = await fetch("/api/settings/schedule", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timeZone, mode, windows: draft, importance }) }).catch(() => undefined);
    if (response?.ok) { location.reload(); return; }
    const body = await response?.json().catch(() => ({})) as { code?: string } | undefined;
    const messages: Record<string, string> = { SCHEDULE_TIME_ZONE_INVALID: "时区无效，请填写 IANA 时区，例如 America/Chicago。",
      SCHEDULE_IMPORTANCE_REQUIRED: "请为每个已批准目标选择重要性。",
      AVAILABILITY_INVALID: "请检查每周可用时段、星期和精力档。",
      AVAILABILITY_ENDS_BEFORE_IT_STARTS: "时间段结束必须晚于开始。" };
    setError(messages[body?.code ?? ""] ?? "保存失败，请重试。");
    setBusy(false);
  };

  return <section className="schedule-setup" aria-label="首次排程问卷">
    <h2>首次排程设置</h2>
    <p>请确认以下信息后生成建议。建议块始终标为「未批准」，不会改写已批准计划。</p>
    <label>所在时区 <input value={timeZone} onChange={(event) => setTimeZone(event.target.value)}
      aria-label="所在时区" required /></label>
    <label>排程模式 <select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
      <option value="buffered">留缓冲：任务间隔 10 分钟，每天最多用 85%</option>
      <option value="asap">尽早完成：优先排入最早可用时段</option>
    </select></label>
    <h3>每周可用时段与惯常精力</h3>
    {draft.map((window, index) => <div className="availability-row" key={index}>
      <span className="availability-days">{DAY_LABELS.map((label, day) =>
        <button type="button" key={day} aria-pressed={window.days.includes(day)} onClick={() => {
          const days = window.days.includes(day) ? window.days.filter((item) => item !== day)
            : [...window.days, day].sort();
          update(index, { days });
        }}>{label}</button>)}</span>
      <label>开始 <input type="time" value={window.start}
        onChange={(event) => update(index, { start: event.target.value })} /></label>
      <label>结束 <input type="time" value={window.end}
        onChange={(event) => update(index, { end: event.target.value })} /></label>
      <label>惯常精力 <select value={window.energy}
        onChange={(event) => update(index, { energy: event.target.value as Window["energy"] })}>
        <option value="low">低</option><option value="medium">中</option><option value="high">高</option>
      </select></label>
      <button type="button" onClick={() => setDraft(draft.filter((_, at) => at !== index))}>删除</button>
    </div>)}
    <button type="button" onClick={() => setDraft([...draft,
      { days: [1, 2, 3, 4, 5], start: "09:00", end: "12:00", energy: "medium" }])}>加一段</button>
    <h3>现有目标的重要性</h3>
    {milestones.map((milestone) => <label key={milestone.id}>{milestone.title}
      <select value={importance[milestone.id] ?? ""} required
        onChange={(event) => setImportance({ ...importance,
          [milestone.id]: event.target.value as "important" | "ordinary" })}>
        <option value="">请选择</option><option value="important">重要</option>
        <option value="ordinary">普通</option>
      </select></label>)}
    <button type="button" className="primary-button" disabled={busy} onClick={() => void submit()}>
      {busy ? "保存中…" : "保存并生成建议"}
    </button>
    {error && <p role="alert">{error}</p>}
  </section>;
}
