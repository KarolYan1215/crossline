"use client";
import { useEffect, useState } from "react";
import type { BackgroundOverview } from "../../lib/background";
import { localStamp } from "@crossline/core";
import { SegmentedControl } from "../ui/controls";
import { Tag } from "../ui/tag";
import { useLocale, useT } from "../locale-context";
import type { Locale } from "../../lib/i18n";

const TIER: Record<BackgroundOverview["engagement"]["tier"], { text: string; tone: "ok" | "warn" | "neutral" }> = {
  active: { text: "照常运行", tone: "ok" },
  cooling: { text: "只做收集分析与日历归类", tone: "warn" },
  dormant: { text: "暂停调用模型", tone: "neutral" }
};
/** 「10/13 22:46」 in the person's zone; the stored times are UTC. Exported for its test. */
export const when = (iso: string | null, timeZone: string): string => iso ? localStamp(iso, timeZone) : "—";
/** 「714 万」 / "7.1M": the week's tokens, rounded the way each language counts large numbers. */
const tokens = (n: number, locale: Locale) => locale === "en" ? (n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : n >= 10_000 ? `${Math.round(n / 1_000)}k` : String(n))
  : n >= 10_000 ? `${Math.round(n / 1_000) / 10} 万` : String(n); // i18n-ignore: the Chinese branch of a per-language number format

type Progress = { commands: Array<{ command: string; status: string; exitCode: number | null }>; files: string[]; searches: string[] } | null;

/** One running assistant task: what it has done so far, polled every few seconds, and 「中止」. */
function RunningTask({ task, timeZone }: { task: BackgroundOverview["running"][number]; timeZone: string }) {
  const t = useT();
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
    <div className="st-row"><span className="st-row-label">{task.title}<small>{t("开始于 {{when}}", { when: when(task.startedAt, timeZone) })}</small></span>
      {state === "ended" ? <Tag tone="neutral">{t("已结束")}</Tag>
        : <button type="button" className="secondary-button" disabled={state === "stopping"} onClick={() => void stop()}>{state === "stopping" ? t("中止中…") : t("中止")}</button>}</div>
    {progress && (progress.commands.length + progress.files.length + progress.searches.length) > 0 && <ol className="bg-steps">
      {progress.searches.map((query) => <li key={`s-${query}`}>{t("搜索：{{query}}", { query })}</li>)}
      {progress.commands.slice(-8).map((command, index) => <li key={`c-${index}`} className="mono">{command.command}{command.exitCode !== null && command.exitCode !== 0 ? t("（退出码 {{code}}）", { code: command.exitCode }) : ""}</li>)}
      {progress.files.slice(-8).map((file) => <li key={`f-${file}`}>{t("写入：{{file}}", { file: file.split(/[\\/]/).at(-1) })}</li>)}
    </ol>}
  </li>;
}

export function BackgroundModule({ overview }: { overview: BackgroundOverview }) {
  const t = useT();
  const locale = useLocale();
  const [kinds, setKinds] = useState(overview.kinds);
  const toggle = async (kind: string, paused: boolean) => {
    const before = kinds;
    setKinds(kinds.map((item) => item.kind === kind ? { ...item, paused } : item));
    const response = await fetch("/api/background", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, paused }) }).catch(() => undefined);
    if (!response?.ok) setKinds(before);
  };
  const tier = TIER[overview.engagement.tier];
  return <div className="st-modules">
    <section className="st-card" aria-label={t("后台任务")}>
      <header><h3>{t("后台任务")}</h3><small>{t("后台开销跟着最近一次本人操作走：48 小时内照常，7 天内只做收集分析与日历归类，更久不调用模型")}</small></header>
      <div className="st-row"><span className="st-row-label">{t("当前状态")}<small>{t("最近一次本人操作 {{when}}", { when: when(overview.engagement.lastActiveAt, overview.timeZone) })}</small></span>
        <Tag tone={tier.tone}>{t(tier.text)}</Tag></div>
      {kinds.map((item) => <div key={item.kind} className="st-row">
        <span className="st-row-label">{t(item.label)}<small>{[t(item.explained),
          t("上次 {{when}}", { when: when(item.lastRunAt, overview.timeZone) }) + (item.lastOk === false ? t("（失败）") : ""),
          t("近 7 天 {{count}} 次、{{tokens}} tokens", { count: item.weekRuns, tokens: tokens(item.weekTokens, locale) })].join(" · ")}</small></span>
        <SegmentedControl label={t("{{kind}}是否运行", { kind: t(item.label) })} value={item.paused ? "paused" : "on"} options={[{ value: "on", label: t("运行", { context: "state" }) }, { value: "paused", label: t("暂停", { context: "state" }) }]}
          onChange={(value) => void toggle(item.kind, value === "paused")} />
      </div>)}
    </section>
    <section className="st-card" aria-label={t("正在运行的助手任务")}>
      <header><h3>{t("正在运行的助手任务")}</h3><small>{t("运行中的命令、搜索和写入的文件，随时可以中止；中止后不会自动重跑")}</small></header>
      {overview.running.length ? <ul className="bg-list">{overview.running.map((task) => <RunningTask key={task.taskId} task={task} timeZone={overview.timeZone} />)}</ul>
        : <p className="muted">{t("现在没有正在运行的助手任务。")}</p>}
    </section>
  </div>;
}
