"use client";
import { useState } from "react";
import type { ConfirmView } from "../../lib/confirm";

type Kind = "as_planned" | "over" | "under" | "not_done";
type Result = { ok: boolean; done?: "step" | "task" | "not_done"; minutes?: number; needsEvidence?: boolean; code?: string; message?: string };

const AMOUNTS = [15, 30, 60] as const;
const FAILURE: Record<string, string> = {
  MATERIALS_PREPARING: "这项任务的材料还在准备，准备好后再确认。",
  CONFIRM_NOT_FOUND: "找不到这个时间块，可能已被删除。",
  ACTIVITY_MINUTES_UNAVAILABLE: "屏幕记录里没有这段时间的数据。"
};
const duration = (minutes: number) => minutes >= 60 ? `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ""}` : `${minutes} 分钟`;

/** The answer as the body the confirm route reads. Exported for its test. */
export function confirmBody(kind: Kind, extra: { minutes?: number; useActivity?: boolean; note?: string; files?: File[] } = {}): FormData {
  const form = new FormData();
  form.set("kind", kind);
  if (extra.minutes) form.set("minutes", String(extra.minutes));
  if (extra.useActivity) form.set("useActivity", "1");
  if (extra.note?.trim()) form.set("note", extra.note.trim());
  for (const file of extra.files ?? []) form.append("file", file);
  return form;
}

/**
 * Two rows (docs/loop-and-scout.md §3): 按预估完成 / 超出预估 / 少于预估 / 未执行, and after 超出 or 少于 by how much. With the screen
 * record's detail consent its estimate is offered as one tap. Confirming the last step of a milestone-bound task can carry its evidence.
 */
export function ConfirmForm({ view }: { view: ConfirmView }) {
  const [kind, setKind] = useState<Kind | undefined>();
  const [custom, setCustom] = useState("");
  const [note, setNote] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | undefined>(view.answered ? { ok: true, ...(view.answered.minutes ? { minutes: view.answered.minutes } : {}),
    done: view.answered.outcome === "not_done" ? "not_done" : view.lastStep ? "task" : "step" } : undefined);
  const evidenceAllowed = view.lastStep && view.milestoneBound;

  const send = async (answer: Kind, extra: { minutes?: number; useActivity?: boolean } = {}) => {
    setBusy(true);
    const response = await fetch(`/api/confirm/${encodeURIComponent(view.messageId)}`, { method: "POST",
      body: confirmBody(answer, { ...extra, ...(evidenceAllowed && answer !== "not_done" ? { note, files } : {}) }) }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as Result | undefined;
    setResult(body ?? { ok: false });
    setBusy(false);
  };

  const label = `${view.title}${view.step ? ` · ${view.step}` : ""}`;
  if (result?.ok) {
    return <section className="confirm-card" aria-live="polite">
      <h2>{label}</h2>
      <p>{result.done === "not_done" ? "已记下：这块没有执行，系统会把它排到后面的空档。"
        : `已记下：用时 ${duration(result.minutes ?? view.blockMinutes)}${result.done === "task" ? "，任务已提交" : "，这一步已完成"}。`}</p>
      {result.needsEvidence && <p className="confirm-note">这项任务挂在里程碑上，附上成果后才能通过验收。
        <a href={`/workbench/${encodeURIComponent(view.orderId)}#complete`}>去任务页补交</a></p>}
      <a className="secondary-button" href="/">回到今日</a>
    </section>;
  }

  return <section className="confirm-card">
    <h2>{label}</h2>
    <p className="confirm-when">{view.day.slice(5).replace("-", "/")} {view.start}–{view.end}，预估 {duration(view.blockMinutes)}{view.lastStep ? "，这是最后一步" : ""}</p>
    {view.activityMinutes ? <p className="confirm-activity">屏幕记录约 {duration(view.activityMinutes)}
      <button type="button" className="secondary-button" disabled={busy} onClick={() => void send("as_planned", { useActivity: true })}>采用</button></p> : null}
    <div className="confirm-row" role="group" aria-label="完成情况">
      <button type="button" className="primary-button" disabled={busy} onClick={() => void send("as_planned")}>按预估完成</button>
      <button type="button" className="secondary-button" aria-pressed={kind === "over"} disabled={busy} onClick={() => setKind("over")}>超出预估</button>
      <button type="button" className="secondary-button" aria-pressed={kind === "under"} disabled={busy} onClick={() => setKind("under")}>少于预估</button>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => void send("not_done")}>未执行</button>
    </div>
    {(kind === "over" || kind === "under") && <div className="confirm-row" role="group" aria-label={kind === "over" ? "超出多少" : "少了多少"}>
      {AMOUNTS.map((amount) => <button key={amount} type="button" className="secondary-button" disabled={busy}
        onClick={() => void send(kind, { minutes: amount })}>{duration(amount)}</button>)}
      <label className="confirm-custom"><span>自定义</span>
        <input type="number" min={1} max={600} inputMode="numeric" value={custom} onChange={(event) => setCustom(event.target.value)} disabled={busy} /> 分钟</label>
      <button type="button" className="secondary-button" disabled={busy || !(Number(custom) > 0)} onClick={() => void send(kind, { minutes: Number(custom) })}>记下</button>
    </div>}
    {evidenceAllowed && <div className="confirm-evidence">
      <p>这项任务挂在里程碑上，附上成果才能通过验收（可以之后再补）。</p>
      <label><span>成果说明</span><input value={note} maxLength={500} placeholder="例如：作业 3 第 1–4 题解答" onChange={(event) => setNote(event.target.value)} disabled={busy} /></label>
      <label><span>文件</span><input type="file" multiple accept="image/*,application/pdf,text/plain" disabled={busy}
        onChange={(event) => setFiles([...(event.target.files ?? [])].slice(0, 5))} /></label>
    </div>}
    {result && !result.ok && <p role="status">{FAILURE[result.code ?? ""] ?? result.message ?? "未能记下，请重试。"}</p>}
  </section>;
}
