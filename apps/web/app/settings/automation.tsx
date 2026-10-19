"use client";

import { useState } from "react";
import { SegmentedControl } from "../ui/controls";
import { Tag } from "../ui/tag";

type Mode = "off" | "review" | "auto";
export type CategoryRow = { category: string; label: string; explained: string; mode: Mode; cleanRuns: number; runsToTrust: number };
export type RecentTask = { taskId: string; title: string; kind: string; status: string; tone: "ok" | "warn" | "risk" | "info" | "neutral"; day: string; workOrderId: string };

const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then((response) => response.ok).catch(() => false);

/** One setting that takes effect on click: the control shows the new value at once and goes back if the save fails. */
function useSetting<T>(initial: T, save: (value: T) => Promise<boolean>) {
  const [value, setValue] = useState(initial);
  const [state, setState] = useState<"" | "saving" | "saved" | "failed">("");
  const change = async (next: T) => {
    const previous = value;
    setValue(next); setState("saving");
    const ok = await save(next);
    if (!ok) setValue(previous);
    setState(ok ? "saved" : "failed");
  };
  return { value, change, state };
}
const SaveState = ({ state }: { state: string }) => state === "failed" ? <small role="status" className="st-fail">未保存</small>
  : state === "saved" ? <small role="status" className="st-ok">已保存</small> : null;

/**
 * 自动化与助手: everything that decides what happens without a click, in one module (it used to be split over the assistant page,
 * the confirmation page's default-approval fold and the composer). Each assistant capability is one on/off control, as are the other
 * switches are two-way. What waits for the person's decision is on 待确认, not here.
 */
export function AutomationModule({ categories, paused, permissionMode, recent, autoHandoff = false, toolsMode = false }: {
  categories: CategoryRow[]; paused: boolean; permissionMode: boolean; recent: RecentTask[];
  /** The assistant works through Crossline's own functions here (no shell): it says what that leaves out. */
  toolsMode?: boolean;
  /** 「自动交给 Agent」: steps on the calendar the system can do start by themselves when their block comes up. Off by default. */
  autoHandoff?: boolean;
}) {
  const pause = useSetting(paused ? "paused" : "running", (value) => post("/api/agent/pause", { paused: value === "paused" }));
  const handoff = useSetting(autoHandoff ? "on" : "off", (value) => post("/api/agent/auto-handoff", { enabled: value === "on" }));
  const permission = useSetting(permissionMode ? "on" : "off", (value) => post("/api/permission-mode", { enabled: value === "on" }));
  return <div className="st-modules">
    <section className="st-card" aria-label="助手能力">
      <header><h3>助手能力</h3><small>开启后，助手做完的结果默认直接生效并通知本人；需要本人判断或涉及对外动作的才进待确认</small></header>
      {toolsMode && <p className="st-note">这里的助手读写和整理文件、查网页、读已接入的邮箱、把待办放进收件箱；不运行脚本、不剪辑音视频。</p>}
      <ul className="st-rows">{categories.map((row) => <CapabilityRow key={row.category} row={row} />)}</ul>
      <div className="st-row"><span className="st-row-label">自动开工<small>已批准、尚未开始的任务由助手接手，一次一个</small></span>
        <SegmentedControl label="助手自动开工" value={pause.value} onChange={(value) => void pause.change(value)}
          options={[{ value: "running", label: "运行" }, { value: "paused", label: "暂停" }]} /><SaveState state={pause.state} /></div>
      <div className="st-row"><span className="st-row-label">自动交给 Agent<small>系统能做的步骤到排定时间（或助手空闲时提前）由后台直接开始；结果按上方各类别处理</small></span>
        <SegmentedControl label="自动交给 Agent" value={handoff.value} onChange={(value) => void handoff.change(value)}
          options={[{ value: "off", label: "关闭" }, { value: "on", label: "开启" }]} /><SaveState state={handoff.state} /></div>
      <p className="st-note">对外发送、付款交易、代为承诺始终由本人完成。</p>
    </section>
    <section className="st-card" aria-label="自动生效">
      <header><h3>自动生效</h3><small>撤销入口在「待确认 · 最近自动生效」</small></header>
      <div className="st-row"><span className="st-row-label">低风险提案<small>在「待确认」前台停留 5 分钟且未拒绝即批准</small></span>
        <SegmentedControl label="低风险提案默认批准" value={permission.value} onChange={(value) => void permission.change(value)}
          options={[{ value: "off", label: "逐项批准" }, { value: "on", label: "默认批准" }]} /><SaveState state={permission.state} /></div>
      <p className="st-note">内部、可撤销的准备步骤始终自动生效，24 小时内可撤销；里程碑、分数线与对外事项始终需要批准。</p>
    </section>
    {recent.length > 0 && <section className="st-card" aria-label="助手近期任务">
      <header><h3>助手近期任务</h3><small>待审阅的产出在「待确认」</small></header>
      <ul className="st-list">{recent.map((task) => <li key={task.taskId}>
        <Tag tone={task.tone}>{task.status}</Tag>
        {task.workOrderId ? <a href={`/workbench/${encodeURIComponent(task.workOrderId)}`}>{task.title}</a> : <span>{task.title}</span>}
        <small>{task.kind} · {task.day}</small>
      </li>)}</ul>
    </section>}
  </div>;
}

function CapabilityRow({ row }: { row: CategoryRow }) {
  // Two positions (decided 2026-10-15): results take effect by default and only those that need the person go to 待确认
  // (`resultNeedsPerson` in the worker), so 「逐次审阅」 and 「自动」 no longer differ. On is stored as the old 「自动」 (`auto_checked`).
  const mode = useSetting<"on" | "off">(row.mode === "off" ? "off" : "on", (value) => post("/api/agent/categories", { category: row.category, mode: value === "on" ? "auto" : "off" }));
  return <li className="st-row" title={row.explained}>
    <span className="st-row-label">{row.label}</span>
    <SegmentedControl label={row.label} value={mode.value} onChange={(value) => void mode.change(value)}
      options={[{ value: "off", label: "关闭" }, { value: "on", label: "开启" }]} />
    <SaveState state={mode.state} />
  </li>;
}
