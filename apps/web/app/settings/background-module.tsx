"use client";
import { useEffect, useState } from "react";
import type { BackgroundOverview } from "../../lib/background";
import { SegmentedControl } from "../ui/controls";
import { Tag } from "../ui/tag";

const TIER: Record<BackgroundOverview["engagement"]["tier"], { text: string; tone: "ok" | "warn" | "neutral" }> = {
  active: { text: "照常运行", tone: "ok" },
  cooling: { text: "只做收集分析与日历归类", tone: "warn" },
  dormant: { text: "暂停调用模型", tone: "neutral" }
};
const when = (iso: string | null) => iso ? `${iso.slice(5, 10).replace("-", "/")} ${iso.slice(11, 16)}` : "—";
const tokens = (n: number) => n >= 10_000 ? `${Math.round(n / 1_000) / 10} 万` : String(n);

type Progress = { commands: Array<{ command: string; status: string; exitCode: number | null }>; files: string[]; searches: string[] } | null;

/** One running assistant task: what it has done so far, polled every few seconds, and 「中止」. */
function RunningTask({ task }: { task: BackgroundOverview["running"][number] }) {
  const [progress, setProgress] = useState<Progress>(null);
  const [state, setState] = useState<"running" | "stopping" | "ended">("running");
  useEffect(() => {
    if (state === "ended") return;
    let live = true;
    const read = async () => {
      const body = await fetch(`/api/agent/tasks/${encodeURIComponent(task.taskId)}/progress`).then((response) => response.json()).catch(() => undefined) as
        { ok?: boolean; progress?: Progress } | undefined;
      if (!live || !body?.ok) return;
      if (!body.progress) setState("ended"); else setProgress(body.progress);
    };
    void read();
    const timer = setInterval(() => void read(), 4_000);
    return () => { live = false; clearInterval(timer); };
  }, [task.taskId, state]);
  const stop = async () => {
    setState("stopping");
    const response = await fetch(`/api/agent/tasks/${encodeURIComponent(task.taskId)}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      .catch(() => undefined);
    if (!response?.ok) setState("running");
  };
  return <li className="bg-running">
    <div className="st-row"><span className="st-row-label">{task.title}<small>开始于 {when(task.startedAt)}</small></span>
      {state === "ended" ? <Tag tone="neutral">已结束</Tag>
        : <button type="button" className="secondary-button" disabled={state === "stopping"} onClick={() => void stop()}>{state === "stopping" ? "中止中…" : "中止"}</button>}</div>
    {progress && (progress.commands.length + progress.files.length + progress.searches.length) > 0 && <ol className="bg-steps">
      {progress.searches.map((query) => <li key={`s-${query}`}>搜索：{query}</li>)}
      {progress.commands.slice(-8).map((command, index) => <li key={`c-${index}`} className="mono">{command.command}{command.exitCode !== null && command.exitCode !== 0 ? `（退出码 ${command.exitCode}）` : ""}</li>)}
      {progress.files.slice(-8).map((file) => <li key={`f-${file}`}>写入：{file.split(/[\\/]/).at(-1)}</li>)}
    </ol>}
  </li>;
}

export function BackgroundModule({ overview }: { overview: BackgroundOverview }) {
  const [kinds, setKinds] = useState(overview.kinds);
  const toggle = async (kind: string, paused: boolean) => {
    const before = kinds;
    setKinds(kinds.map((item) => item.kind === kind ? { ...item, paused } : item));
    const response = await fetch("/api/background", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, paused }) }).catch(() => undefined);
    if (!response?.ok) setKinds(before);
  };
  const tier = TIER[overview.engagement.tier];
  return <div className="st-modules">
    <section className="st-card" aria-label="后台任务">
      <header><h3>后台任务</h3><small>后台开销跟着最近一次本人操作走：48 小时内照常，7 天内只做收集分析与日历归类，更久不调用模型</small></header>
      <div className="st-row"><span className="st-row-label">当前状态<small>最近一次本人操作 {when(overview.engagement.lastActiveAt)}</small></span>
        <Tag tone={tier.tone}>{tier.text}</Tag></div>
      {kinds.map((item) => <div key={item.kind} className="st-row">
        <span className="st-row-label">{item.label}<small>{item.explained} · 上次 {when(item.lastRunAt)}{item.lastOk === false ? "（失败）" : ""} · 近 7 天 {item.weekRuns} 次、{tokens(item.weekTokens)} tokens</small></span>
        <SegmentedControl label={`${item.label}是否运行`} value={item.paused ? "paused" : "on"} options={[{ value: "on", label: "运行" }, { value: "paused", label: "暂停" }]}
          onChange={(value) => void toggle(item.kind, value === "paused")} />
      </div>)}
    </section>
    <section className="st-card" aria-label="正在运行的助手任务">
      <header><h3>正在运行的助手任务</h3><small>运行中的命令、搜索和写入的文件，随时可以中止；中止后不会自动重跑</small></header>
      {overview.running.length ? <ul className="bg-list">{overview.running.map((task) => <RunningTask key={task.taskId} task={task} />)}</ul>
        : <p className="muted">现在没有正在运行的助手任务。</p>}
    </section>
  </div>;
}
