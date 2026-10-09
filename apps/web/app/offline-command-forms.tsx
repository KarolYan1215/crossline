"use client";

import { useEffect, useState } from "react";
import {
  createCommand, deviceId, enqueue, listConflicts, listDeadLetters, nextSequence, rememberWorkspace,
  replayQueue, type OfflineCommand
} from "./offline-queue";
import { looksLikeScheduleCommand, type DeadLetter } from "@crossline/core";
import type { Change } from "../lib/impact";
import type { RoutedOutcome } from "../lib/input";
import { Composer, type ComposerInput } from "./chat/composer";
import { ImpactCard, useImpact } from "./task/impact";
import { undoOperation } from "./undo-center";

/** Renews (or first-issues) this browser's 24-hour device lease. Best-effort: a lease that fails to
 * renew only matters once it actually expires, which `POST /api/commands` would then start refusing —
 * failing this call must not block replay itself. */
async function renewDeviceLease(): Promise<void> {
  await fetch("/api/auth/device-lease", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: deviceId() })
  }).catch(() => undefined);
}

export function OfflineReplay({ workspaceId }: { workspaceId: string }) {
  const [dead, setDead] = useState<Array<DeadLetter<OfflineCommand>>>([]);
  const [conflicts, setConflicts] = useState<Array<DeadLetter<OfflineCommand>>>([]);
  useEffect(() => {
    // Remembered here, not only read at submit time: the `/offline` fallback page is served from the
    // service worker's precache with no server-rendered props at all, so this is the only place that
    // ever gets a chance to write it down while the app is actually online and authenticated.
    rememberWorkspace(workspaceId);
    const replay = async () => {
      try {
        await renewDeviceLease();
        const summary = await replayQueue(workspaceId);
        setDead(await listDeadLetters(workspaceId));
        setConflicts(await listConflicts(workspaceId));
        if (summary.sent > 0) location.reload();
      } catch { /* IndexedDB unavailable; the forms below still report this per submit. */ }
    };
    window.addEventListener("online", replay);
    if (navigator.onLine) void replay();
    return () => window.removeEventListener("online", replay);
  }, [workspaceId]);

  // A dead letter or conflict is shown where the queue lives. Silently dropping either would be the
  // same as the old behaviour of retrying forever: either way the person never learns what happened.
  const total = dead.length + conflicts.length;
  if (!total) return null;
  return <aside className="dead-letters" role="alert">
    <b>{dead.length > 0 && `${dead.length} 条离线记录无法同步`}{dead.length > 0 && conflicts.length > 0 && " · "}
      {conflicts.length > 0 && `${conflicts.length} 条与其他设备冲突`}</b>
    <ul>{[...dead, ...conflicts].map((entry) => <li key={entry.command.clientCommandId}>
      <span>{String(entry.command.payload.title ?? entry.command.type)}</span>
      <small>{entry.reason} · {entry.failedAt.slice(0, 16).replace("T", " ")}</small>
    </li>)}</ul>
    <a href="/offline">查看并处理 →</a>
  </aside>;
}

/** A change to a planned task that the router read out of the input: previewed across the lines, applied on 应用. */
function ScheduleChange({ change, summary }: { change: Change; summary: string }) {
  const impact = useImpact();
  const [autoApply, setAutoApply] = useState(false);
  useEffect(() => { void impact.propose(change); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="schedule-change">
    <p className="gen"><b>日程指令</b> · {summary}</p>
    {impact.busy && !impact.pending && <small role="status">计算影响…</small>}
    {impact.pending && <ImpactCard impact={impact.pending.impact} busy={impact.busy} onCancel={impact.cancel} onApply={() => {
      if (autoApply) void fetch("/api/input/route", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ autoApply: true }) });
      void impact.apply();
    }} />}
    {impact.pending && <label className="schedule-change-auto"><input type="checkbox" checked={autoApply} onChange={(event) => setAutoApply(event.target.checked)} />
      此后日程指令直接应用</label>}
    {impact.error && <small role="status">{impact.error}</small>}
  </div>;
}

/** 「撤销刚才的…」 read by the router: the operation it names, taken back on 撤销 (never applied without the click). */
function UndoSuggestion({ opId, label, summary }: { opId: string; label: string; summary: string }) {
  const [status, setStatus] = useState("");
  if (!opId) return <div className="schedule-change"><p><b>撤销</b> · 最近 24 小时内没有与「{summary || "该描述"}」对应的操作；可在顶栏「撤销」中查看全部操作。</p></div>;
  return <div className="schedule-change">
    <p><b>撤销</b> · {label}</p>
    <div className="schedule-change-actions">
      <button type="button" className="primary-button" disabled={Boolean(status)} onClick={async () => {
        setStatus("正在撤销…");
        const result = await undoOperation(opId);
        setStatus(result.message);
        if (result.ok) setTimeout(() => location.reload(), 500);
      }}>撤销</button>
      {status && <small role="status">{status}</small>}
    </div>
  </div>;
}

/** What the input box wrote besides captures: each line says where it went, and every one of them is in the top bar's 撤销. */
function WrittenItems({ goals, milestones, lines, records, failed, events, profile }: Pick<RoutedOutcome, "goals" | "milestones" | "lines" | "records" | "failed" | "events" | "profile">) {
  if (!goals.length && !milestones.length && !lines.length && !records.length && !failed.length && !events.length && !profile.length) return null;
  return <ul className="routed-written">
    {goals.map((goal) => <li key={`g-${goal.lineId}-${goal.title}`}><b>长期目标</b> · {goal.line}：{goal.title} <a href="/milestones">主线 →</a></li>)}
    {milestones.map((item) => <li key={item.id}><b>里程碑草稿</b> · {item.line}：{item.title}{item.date ? `（${item.date}）` : ""} <a href="/milestones">在主线页审阅 →</a></li>)}
    {lines.map((line) => <li key={line.id}><b>新主线</b> · {line.label} <a href={`/onboarding?line=${encodeURIComponent(line.id)}`}>开始这条主线的访谈 →</a></li>)}
    {records.map((text, index) => <li key={`r-${index}`}><b>已记录</b> · {text}</li>)}
    {events.map((event, index) => <li key={`e-${index}`}><b>已加入日程</b> · {event.title} · {event.when}{event.placedBySystem ? "（系统选定的空档）" : ""}
      {event.moved ? ` · 重排了 ${event.moved} 个与之冲突的任务块，其余不变` : " · 未影响已排任务"} <a href="/plan">计划 →</a></li>)}
    {profile.map((text, index) => <li key={`p-${index}`}><b>已交给访谈</b> · {text.slice(0, 40)} <a href="/onboarding">画像 →</a></li>)}
    {failed.map((text, index) => <li key={`f-${index}`} role="alert">{text}</li>)}
  </ul>;
}

/**
 * 快速收集. A plain line is captured at once (and queued offline without a connection); a batch, or a line that reads like an
 * instruction about planned work, goes to the router, which splits it into captures and changes to preview. Linked tasks, milestones and
 * materials travel with the capture as its context; files are attached to it.
 */
export function OfflineCaptureForm({ ownerId, workspaceId }: { ownerId: string; workspaceId: string }) {
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [changes, setChanges] = useState<Array<{ change: Change; summary: string }>>([]);
  const [undos, setUndos] = useState<Array<{ opId: string; label: string; summary: string }>>([]);
  const [written, setWritten] = useState<Pick<RoutedOutcome, "goals" | "milestones" | "lines" | "records" | "failed" | "events" | "profile"> | null>(null);

  const capture = async ({ text, files, mentions }: ComposerInput): Promise<boolean> => {
    const [title, ...rest] = text.split("\n");
    const linked = mentions.length ? `关联：${mentions.map((item) => `${{ material: "资料", task: "任务", milestone: "里程碑" }[item.kind]}「${item.title}」`).join("；")}` : "";
    const command = createCommand(ownerId, workspaceId, await nextSequence(workspaceId), "task.capture", {
      title: (title || files[0]?.name || "附件").slice(0, 240), context: [rest.join("\n").trim(), linked].filter(Boolean).join("\n").slice(0, 500) });
    const save = async (message: string) => {
      try {
        await enqueue(workspaceId, command);
        // A queued capture has no server row yet for a file to belong to, so files picked offline are not claimed as saved.
        setStatus(files.length ? `${message}；离线时选择的 ${files.length} 个附件未保存，联网后需重新上传` : message);
        return true;
      } catch { setStatus("浏览器存储不可用，未能离线保存；请复制内容后重试。"); return false; }
    };
    if (!navigator.onLine) return save("已离线保存，联网后自动同步");
    try {
      const response = await fetch("/api/commands", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) });
      if (!response.ok) { setStatus("输入无效，请检查后重试"); return false; }
      if (files.length) {
        // The command's client id is the capture's real id, so files attach to it directly.
        const upload = new FormData();
        for (const file of files) upload.append("file", file);
        const uploaded = await fetch(`/api/captures/${encodeURIComponent(command.clientCommandId)}/attachments`, { method: "POST", body: upload }).catch(() => null);
        if (!uploaded?.ok) { setStatus("已收集，附件上传失败，可在任务页重试"); return true; }
      }
      setStatus("已收集 · 约 1 分钟后完成分类与估时，结果进入「待确认」");
      return true;
    } catch { return save("网络不可用，已保存并等待同步"); }
  };

  const submit = async (input: ComposerInput): Promise<boolean> => {
    setChanges([]); setUndos([]); setWritten(null);
    if (!input.batch && !looksLikeScheduleCommand(input.text)) return capture(input);
    if (!navigator.onLine) return capture(input);
    setBusy(true); setStatus(input.batch ? "正在拆分…" : "正在识别指令…");
    try {
      const response = await fetch("/api/input/route", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: input.text, batch: input.batch, mentions: input.mentions }) });
      const result = await response.json().catch(() => null) as ({ ok?: boolean } & Partial<RoutedOutcome>) | null;
      if (!response.ok || !result?.ok) { setStatus("未能处理，已按普通收集保存"); return capture(input); }
      if (input.files.length && result.captured?.[0]) {
        const upload = new FormData();
        for (const file of input.files) upload.append("file", file);
        await fetch(`/api/captures/${encodeURIComponent(result.captured[0].id)}/attachments`, { method: "POST", body: upload }).catch(() => null);
      }
      setChanges(result.changes ?? []);
      setUndos(result.undos ?? []);
      setWritten({ goals: result.goals ?? [], milestones: result.milestones ?? [], lines: result.lines ?? [], records: result.records ?? [], failed: result.failed ?? [],
        events: result.events ?? [], profile: result.profile ?? [] });
      // A question is not stored: it goes to 小助手, which answers it with what it knows about the person.
      for (const question of result.questions ?? []) window.dispatchEvent(new CustomEvent("crossline:ask-assistant", { detail: question }));
      setStatus([result.captured?.length ? `已收集 ${result.captured.length} 项` : "", result.applied?.length ? `已应用：${result.applied.join("；")}` : "",
        result.changes?.length ? `${result.changes.length} 项日程调整待确认` : "", result.undos?.length ? "撤销待确认" : "",
        result.questions?.length ? "问题已转给小助手" : ""].filter(Boolean).join(" · ")
        || (result.goals?.length || result.milestones?.length || result.lines?.length || result.records?.length || result.events?.length || result.profile?.length ? "" : "无可处理内容"));
      if (result.events?.length) window.dispatchEvent(new Event("crossline:plan-changed"));
      if (result.goals?.length || result.milestones?.length || result.lines?.length) window.dispatchEvent(new Event("crossline:pending-changed"));
      return true;
    } finally { setBusy(false); }
  };

  return <Composer mode="capture" busy={busy} placeholder="任务、日程（每周二 10 点组会）、改期、长期目标、里程碑、记录或问题" onSubmit={submit}>
    {status && <small className="muted composer-status" role="status">{status}</small>}
    {changes.map((item, index) => <ScheduleChange key={index} change={item.change} summary={item.summary} />)}
    {undos.map((item, index) => <UndoSuggestion key={`undo-${index}`} {...item} />)}
    {written && <WrittenItems {...written} />}
  </Composer>;
}
