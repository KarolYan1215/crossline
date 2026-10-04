"use client";

import { useState } from "react";

type Level = "granted" | "denied" | "unasked";
type Entry = { start: string; end: string; app: string; title: string; category: string; idle: boolean };
type State = { minutes: Level; detail: Level; pausedUntil: string | null; blacklist: string[]; entries: Entry[] };

const send = (body: Record<string, unknown>) => fetch("/api/settings/local-activity", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
});

/**
 * The whole privacy surface for screen activity in one card: the two levels, a pause, the person's own never-record
 * words, and the one screen on which the stored window titles can be read and wiped. Unlike `LocalActivityConsent` (a
 * one-time prompt that disappears once answered) this stays, because the prompt had no way back to it.
 */
export function LocalActivityToggle({ consent, detail, pausedUntil, blacklist }: { consent: Level; detail: Level; pausedUntil: string | null; blacklist: string[] }) {
  const [state, setState] = useState<State>({ minutes: consent, detail, pausedUntil, blacklist, entries: [] });
  const [words, setWords] = useState(blacklist.join("、"));
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const act = async (body: Record<string, unknown>, apply: (previous: State) => State, message = "") => {
    setBusy(true); setNote("");
    const response = await send(body).catch(() => undefined);
    setBusy(false);
    if (response?.ok) { setState(apply); setNote(message); } else setNote("没有保存成功，请重试。");
  };
  const refresh = async () => {
    const response = await fetch("/api/settings/local-activity").catch(() => undefined);
    if (!response?.ok) return setNote("读取记录失败。");
    const data = await response.json() as { entries: Entry[] };
    setState((previous) => ({ ...previous, entries: data.entries })); setShown(true);
  };

  const paused = state.pausedUntil && Date.parse(state.pausedUntil) > Date.now();
  const level = state.detail === "granted" ? "应用 + 窗口标题（仅本机）" : state.minutes === "granted" ? "只记活跃分钟数" : state.minutes === "denied" ? "已关闭" : "尚未设置";
  const clock = (iso: string) => new Date(iso).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

  return <div className="activity-card">
    <div className="settings-row">
      <span>屏幕活动：{level}{paused ? ` · 已暂停到 ${clock(state.pausedUntil!)}` : ""}</span>
      <div className="settings-row-actions">
        <button type="button" className="secondary-button" disabled={busy || state.detail === "granted"}
          onClick={() => void act({ detail: "granted" }, (p) => ({ ...p, detail: "granted", minutes: "granted" }))}>记录应用 + 窗口</button>
        <button type="button" className="secondary-button" disabled={busy || (state.minutes === "granted" && state.detail !== "granted")}
          onClick={() => void act({ consent: "granted", detail: "denied" }, (p) => ({ ...p, detail: "denied", minutes: "granted" }))}>只记分钟数</button>
        <button type="button" className="secondary-button" disabled={busy || state.minutes === "denied"}
          onClick={() => void act({ consent: "denied" }, (p) => ({ ...p, minutes: "denied", detail: "denied" }))}>关闭</button>
      </div>
    </div>
    <p className="review-note">每分钟读一次前台应用名、窗口标题和距上次输入的时间；不记录按键、不截屏、不上传。窗口标题只存在这台电脑，不会发给任何模型，14 天后自动抹掉。
      银行、密码管理器、无痕窗口默认完全不记录。</p>
    {state.minutes === "granted" && <div className="settings-row">
      <span>暂停记录</span>
      <div className="settings-row-actions">
        {[[60, "1 小时"], [240, "4 小时"], [1440, "到明天"]].map(([minutes, label]) => <button type="button" key={String(minutes)} className="secondary-button" disabled={busy}
          onClick={() => void act({ pauseMinutes: minutes }, (p) => ({ ...p, pausedUntil: new Date(Date.now() + Number(minutes) * 60_000).toISOString() }))}>{label}</button>)}
        <button type="button" className="secondary-button" disabled={busy || !paused}
          onClick={() => void act({ pauseMinutes: 0 }, (p) => ({ ...p, pausedUntil: null }))}>恢复</button>
      </div>
    </div>}
    <label className="settings-row">
      <span>再加一些“不要记录”的词（用顿号或逗号分隔，窗口标题或应用名含有就整条跳过）</span>
      <input value={words} onChange={(event) => setWords(event.target.value)} aria-label="不记录的词" />
      <button type="button" className="secondary-button" disabled={busy}
        onClick={() => void act({ blacklist: words.split(/[、,，;；\n]/).map((word) => word.trim()).filter(Boolean) }, (p) => p, "已保存。")}>保存</button>
    </label>
    <div className="settings-row">
      <span>系统现在存着什么</span>
      <div className="settings-row-actions">
        <button type="button" className="secondary-button" onClick={() => void refresh()}>查看最近记录</button>
        <button type="button" className="secondary-button" disabled={busy}
          onClick={() => void act({ clearTitles: true }, (p) => ({ ...p, entries: p.entries.map((entry) => ({ ...entry, title: "" })) }), "已抹掉所有窗口标题。")}>清除所有窗口标题</button>
      </div>
    </div>
    {shown && (state.entries.length === 0 ? <p className="muted">还没有记录。</p> : <ul className="activity-entries">
      {state.entries.map((entry) => <li key={`${entry.start}-${entry.app}`}>{clock(entry.start)} · {entry.idle ? "离开" : entry.app} · {entry.title || "（无标题）"}</li>)}
    </ul>)}
    {note && <p role="status">{note}</p>}
  </div>;
}
