"use client";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { workflowLineDiff, type WorkflowDryRun } from "@crossline/core";
import { useT } from "../../locale-context";
import { Markdown } from "../../ui/markdown";
import { LineTag, Tag } from "../../ui/tag";
import { VoiceField } from "../../ui/voice/voice-input";
import { fitTextarea } from "../../chat/composer";
import { WORKFLOW_STATUS, WORKFLOW_TAG } from "../workflow-list";
import type { WorkflowDetail, WorkflowTurnView, WorkflowVersionView } from "../../../lib/workflows";

const POLL_MS = 900;
const when = (iso: string) => iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))} ${iso.slice(11, 16)}` : "";
const SOURCE: Record<string, string> = { import: "原有设置", created: "建立", change: "修改", thread: "对话中修改", rollback: "回到旧版", grown: "助手修订" };
const post = (url: string, body: unknown, method = "POST") => fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (response) => ({ ok: response.ok, body: await response.json().catch(() => ({})) as Record<string, unknown> }))
  .catch(() => ({ ok: false, body: {} as Record<string, unknown> }));

/**
 * One workflow's page (2026-11-10): its conversation on the left — the person's words, the designer's answer as it streams, every lookup it
 * made shown as a tool call, and each change marked with the version it made — and its versions on the right: compared line by line,
 * tried without effect (试运行), and gone back to (回到此版, itself a new version).
 */
export function WorkflowView({ initial }: { initial: WorkflowDetail }) {
  const t = useT();
  const router = useRouter();
  const [detail, setDetail] = useState(initial);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const [compare, setCompare] = useState<{ from: number; to: number } | undefined>();
  const [dryRun, setDryRun] = useState<WorkflowDryRun | undefined>();
  const box = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const load = async () => {
    const response = await fetch(`/api/workflows/${encodeURIComponent(detail.id)}`, { cache: "no-store" }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { detail?: WorkflowDetail } | undefined;
    if (body?.detail) setDetail(body.detail);
  };
  // A turn streaming: asked again until it is done (the worker writes the answer into the ledger as it comes).
  useEffect(() => {
    if (!detail.running) return;
    const timer = setTimeout(() => void load(), POLL_MS);
    return () => clearTimeout(timer);
  });
  // A conversation that made its workflow moves to the workflow's own address.
  useEffect(() => { if (detail.exists && detail.id !== initial.id) router.replace(`/automation/${encodeURIComponent(detail.id)}`); }, [detail.exists, detail.id, initial.id, router]);
  const lastText = detail.turns.at(-1)?.text.length ?? 0;
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [detail.turns.length, lastText]);
  useEffect(() => fitTextarea(box.current), [text]);

  const send = async () => {
    const words = text.trim();
    if (!words || detail.running) return;
    setBusy("send"); setNote("");
    const result = await post(`/api/workflows/${encodeURIComponent(detail.id)}`, { action: "turn", text: words });
    setBusy("");
    if (!result.ok) { setNote(String(result.body.message ?? t("没有发出，稍后再试。"))); return; }
    setText("");
    await load();
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
  };
  const rollback = async (version: number) => {
    setBusy(`rollback:${version}`); setNote("");
    const result = await post(`/api/workflows/${encodeURIComponent(detail.id)}`, { action: "rollback", version });
    setBusy("");
    setNote(result.ok ? (result.body.needsConsent ? t("已回到第 {{from}} 版，保存为第 {{version}} 版；它读取的网站超出本人同意过的范围，确认风险后才会运行", { from: version, version: Number(result.body.version) })
      : t("已回到第 {{from}} 版，保存为第 {{version}} 版", { from: version, version: Number(result.body.version) })) : t("没有改动：这一版就是现在的内容"));
    await load();
  };
  const tryVersion = async (version: number) => {
    setBusy(`dry:${version}`); setDryRun(undefined);
    const result = await post(`/api/workflows/${encodeURIComponent(detail.id)}`, { action: "dry_run", version });
    setBusy("");
    if (result.ok) setDryRun(result.body.run as WorkflowDryRun); else setNote(t("试运行没有完成"));
  };
  const act = async (action: "run" | "pause" | "resume" | "delete") => {
    if (action === "delete" && !window.confirm(t("删除工作流「{{name}}」？", { name: detail.title }))) return;
    setBusy(action);
    const result = action === "delete" ? await post(`/api/automations/${detail.id}`, {}, "DELETE") : await post(`/api/automations/${detail.id}`, { action });
    setBusy("");
    if (action === "delete" && result.ok) { router.push("/automation"); return; }
    setNote(!result.ok ? t("没有完成，稍后再试。") : action === "run" ? t("已提交运行，结果会发消息") : action === "pause" ? t("已暂停。") : t("已恢复。"));
    await load();
  };

  const versions = [...detail.versions].reverse();
  const item = detail.item;
  return <div className="wf-page">
    <header className="wf-head">
      <div><h2>{detail.title || t("新的工作流")}</h2>
        {item && <p className="wf-tags"><Tag tone={item.tag === "grown" ? "info" : "neutral"}>{t(WORKFLOW_TAG[item.tag])}</Tag>
          <Tag tone={item.status === "active" ? "ok" : item.status === "off" ? "neutral" : "warn"}>{t(WORKFLOW_STATUS[item.status])}</Tag>
          {item.lineLabel && <LineTag line={item.lineId}>{item.lineLabel}</LineTag>}<small>{item.when}</small></p>}</div>
      {item?.kind === "automation" && <span className="wf-actions">
        <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => void act("run")}>{t("立即运行")}</button>
        <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => void act(item.status === "off" ? "resume" : "pause")}>{item.status === "off" ? t("恢复") : t("暂停")}</button>
        <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => void act("delete")}>{t("删除")}</button>
      </span>}
    </header>
    {note && <p role="status" className="st-note">{note}</p>}
    <div className="wf-columns">
      <section className="wf-thread" aria-label={t("对话")}>
        <ol className="wf-turns">{detail.turns.map((turn) => <Turn key={turn.id} turn={turn} />)}</ol>
        <div ref={end} />
        <form className="wf-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
          <VoiceField kind="note"><textarea ref={box} value={text} rows={2} maxLength={2000} onChange={(event) => setText(event.target.value)} onKeyDown={onKey}
            aria-label={t("对这个工作流说")} placeholder={detail.kind === "grown" ? t("说它哪里要改，例如：多读一页收藏夹，按话题分文件") : t("说它哪里要改，例如：改成每天两次；只看王老师的邮件")} /></VoiceField>
          <button type="submit" className="primary-button" disabled={!text.trim() || detail.running || busy === "send"}>{detail.running ? t("正在回答…") : t("发送")}</button>
        </form>
      </section>
      <aside className="wf-versions" aria-label={t("版本")}>
        <h3>{t("版本 · {{n}}", { n: detail.versions.length })}</h3>
        {versions.length === 0 ? <p className="muted">{t("建好后每次修改都会留一个版本。")}</p>
          : <ol>{versions.map((version, index) => {
            const previous = versions[index + 1];
            return <li key={version.version} className={version.current ? "wf-version is-current" : "wf-version"}>
              <span><b>{t("第 {{version}} 版", { version: version.version })}</b>{version.current && <Tag tone="ok">{t("当前")}</Tag>}
                <small>{t(SOURCE[version.source] ?? "修改")} · {when(version.at)}</small></span>
              {version.note && <small className="wf-version-note">{version.note}</small>}
              <span className="wf-version-actions">
                {previous && <button type="button" className="text-button" aria-pressed={compare?.to === version.version && compare.from === previous.version}
                  onClick={() => setCompare(compare?.to === version.version ? undefined : { from: previous.version, to: version.version })}>{t("对比上一版")}</button>}
                {!version.current && detail.versions.some((item) => item.current) && <button type="button" className="text-button"
                  onClick={() => setCompare({ from: version.version, to: detail.versions.find((item) => item.current)!.version })}>{t("对比当前")}</button>}
                <button type="button" className="text-button" disabled={busy === `dry:${version.version}`} onClick={() => void tryVersion(version.version)}>{t("试运行")}</button>
                {!version.current && <button type="button" className="secondary-button" disabled={busy === `rollback:${version.version}`} onClick={() => void rollback(version.version)}>{t("回到此版")}</button>}
              </span>
            </li>;
          })}</ol>}
        {compare && <VersionDiff from={detail.versions.find((item) => item.version === compare.from)} to={detail.versions.find((item) => item.version === compare.to)} onClose={() => setCompare(undefined)} />}
        {dryRun && <DryRun run={dryRun} onClose={() => setDryRun(undefined)} />}
      </aside>
    </div>
  </div>;
}

function Turn({ turn }: { turn: WorkflowTurnView }) {
  const t = useT();
  return <li className={`wf-turn is-${turn.role}${turn.state === "failed" ? " is-failed" : ""}`}>
    {turn.role !== "person" && turn.items.filter((item) => item.type === "tool").map((item, index) => item.type === "tool" &&
      <details key={index} className="wf-tool"><summary><code>{item.name}</code>{!item.ok && <Tag tone="risk">{t("失败")}</Tag>}<small>{item.args}</small></summary>
        <pre>{item.result}</pre></details>)}
    {turn.text ? (turn.role === "person" ? <p data-user-text>{turn.text}</p> : <Markdown className="gen" text={turn.text} />)
      : turn.state === "running" && <p className="muted">{t("正在思考…")}</p>}
    {turn.state === "running" && turn.text && <span className="wf-cursor" aria-hidden="true" />}
    {turn.items.map((item, index) => item.type === "version" ? <p key={index} className="wf-made"><Tag tone="info">{t("成为第 {{version}} 版", { version: item.version })}</Tag>
      {item.note && <small>{item.note}</small>}</p> : item.type === "status" ? <p key={index} className="wf-made"><small>{item.text}</small></p> : null)}
    <small className="wf-when">{when(turn.createdAt)}</small>
  </li>;
}

function VersionDiff({ from, to, onClose }: { from: WorkflowVersionView | undefined; to: WorkflowVersionView | undefined; onClose: () => void }) {
  const t = useT();
  if (!from || !to) return null;
  const lines = workflowLineDiff(from.text, to.text);
  const changed = lines.filter((line) => line.op !== "same").length;
  return <section className="wf-diff" aria-label={t("版本对比")}>
    <header><b>{t("第 {{from}} 版 → 第 {{to}} 版", { from: from.version, to: to.version })}</b><small>{t("{{n}} 行不同", { n: changed })}</small>
      <button type="button" className="text-button" onClick={onClose}>{t("收起")}</button></header>
    <pre>{lines.map((line, index) => <span key={index} className={`wf-diff-${line.op}`}>{line.op === "add" ? "+ " : line.op === "del" ? "- " : "  "}{line.text}{"\n"}</span>)}</pre>
  </section>;
}

function DryRun({ run, onClose }: { run: WorkflowDryRun; onClose: () => void }) {
  const t = useT();
  return <section className="wf-dry" aria-label={t("试运行")}>
    <header><b>{t("试运行 · 第 {{version}} 版", { version: run.version })}</b><button type="button" className="text-button" onClick={onClose}>{t("收起")}</button></header>
    <p><small>{t("触发")}</small> {run.trigger}</p>
    {run.next.length > 0 && <p><small>{t("接下来")}</small> {run.next.map((iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })).join(" · ")}</p>}
    {run.waitsFor && <p><small>{t("等待")}</small> {run.waitsFor}</p>}
    <ol>{run.steps.map((step, index) => <li key={index}>{step.title} {step.by === "person" ? <Tag tone="warn">{t("本人")}</Tag> : <Tag>{t("助手")}</Tag>}
      {step.leaves && step.by !== "person" && <Tag tone="risk">{t("会离开本机，真正运行时交给本人")}</Tag>}</li>)}</ol>
    {run.reminder && <p><small>{t("提醒")}</small> {run.reminder}</p>}
    {run.prompt && <details><summary>{t("助手会收到的说明")}</summary><pre>{run.prompt}</pre></details>}
    {run.outputs.length > 0 && <p><small>{t("要交出")}</small> {run.outputs.join("、")}</p>}
    <ul className="wf-checks">{run.checks.map((check, index) => <li key={index}><Tag tone={check.ok ? "ok" : "warn"}>{check.ok ? t("通过") : t("注意")}</Tag> {check.text}</li>)}</ul>
  </section>;
}
