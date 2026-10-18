"use client";

import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { DECISION_SECONDS_MAX, type Ask, type AskField, type AskOption, type AskProgress } from "@crossline/core";
import { Tag } from "../ui/tag";
import { Clamp } from "../ui/clamp";
import { RiskList } from "../milestones/risk-glyph";
import { answerBody, answerProblem, askOutcome, askSources, shortDay } from "./model";
import type { AskPreviewData } from "./types";
import "./asks.css";

const URGENCY: Record<Ask["urgency"], string> = { now: "今天要答", soon: "这周", later: "不急" };


async function post(path: string, body: Record<string, unknown>): Promise<{ ok?: boolean; code?: string } | null> {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  return await response?.json().catch(() => null) as { ok?: boolean; code?: string } | null;
}

/** An option needs its follow-up fields filled before it can be sent: a required one, or optional ones with nowhere else to say it. */
/**
 * Seconds the card has been at least half on screen while the page was in front: what deciding it cost, sent with the answer (capped
 * at `DECISION_SECONDS_MAX`, past which the person had walked away). A list shows several cards at once, so mounting is not looking.
 */
function useVisibleSeconds(ref: RefObject<HTMLElement | null>): () => number {
  const total = useRef(0);
  const since = useRef<number | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let inView = typeof IntersectionObserver === "undefined";
    const update = () => {
      const on = inView && document.visibilityState === "visible";
      const now = performance.now();
      if (on && since.current === null) since.current = now;
      if (!on && since.current !== null) { total.current += now - since.current; since.current = null; }
    };
    const observer = typeof IntersectionObserver === "undefined" ? undefined
      : new IntersectionObserver(([entry]) => { inView = Boolean(entry?.isIntersecting && entry.intersectionRatio >= 0.5); update(); }, { threshold: [0, 0.5, 1] });
    observer?.observe(element);
    document.addEventListener("visibilitychange", update);
    update();
    return () => { observer?.disconnect(); document.removeEventListener("visibilitychange", update); inView = false; update(); };
  }, [ref]);
  return () => Math.min(DECISION_SECONDS_MAX, Math.round((total.current + (since.current === null ? 0 : performance.now() - since.current)) / 1000));
}

const needsFields = (ask: Ask, option: AskOption) => Boolean(option.fields?.length) && (option.fields!.some((field) => field.required) || !ask.freeText);

/**
 * One question, answerable in place. It says what is asked, why, what an answer does and what silence does, links what it is about,
 * and opens a preview of that thing when there is one. A single-choice ask is answered with one click (an option with follow-up fields
 * opens them under the options); a multiple-choice ask is ticked and confirmed once; the person's own words go in the input that is
 * always there when the ask takes them, its placeholder the recommended answer.
 */
export function AskCard({ ask, preview, onDone, level = 3 }: { ask: Ask; preview?: AskPreviewData | undefined; onDone: (id: string) => void; level?: 3 | 4 }) {
  const many = ask.select === "many";
  const [picked, setPicked] = useState<string[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const cardRef = useRef<HTMLLIElement>(null);
  const seconds = useVisibleSeconds(cardRef);
  const answerable = ask.options.filter((option) => !option.href);
  const links = ask.options.filter((option) => option.href);
  const chosen = answerable.filter((option) => picked.includes(option.id));
  const fields = uniqueFields(chosen.flatMap((option) => option.fields ?? []));

  const send = async (path: string, body: Record<string, unknown>) => {
    setBusy(true); setStatus("保存中…");
    const result = await post(path, body);
    setBusy(false);
    if (result?.ok) { onDone(ask.id); return; }
    setStatus(answerProblem(result?.code));
  };
  const submit = (optionIds: string[]) => void send("/api/asks/answer", answerBody(ask.id, optionIds, values, note, seconds()));
  const initials = (options: AskOption[]) => Object.fromEntries(options.flatMap((option) => option.fields ?? [])
    .filter((field) => field.initial).map((field) => [field.id, field.initial!]));

  const chooseOne = (option: AskOption) => {
    if (needsFields(ask, option)) { setPicked([option.id]); setValues(initials([option])); return; }
    submit([option.id]);
  };
  const toggle = (option: AskOption) => {
    const next = picked.includes(option.id) ? picked.filter((id) => id !== option.id) : [...picked, option.id];
    setPicked(next);
    setValues((current) => ({ ...initials(answerable.filter((item) => next.includes(item.id))), ...current }));
  };
  const outcome = askOutcome(ask);
  const sources = askSources(ask);

  return <li ref={cardRef} className="ask-card ak-card" data-line={ask.line} data-urgency={ask.urgency} data-kind={ask.kind}>
    <AskMeta ask={ask} />
    {level === 4 ? <h4 className="ak-title">{ask.title}</h4> : <h3 className="ak-title">{ask.title}</h3>}
    <dl className="ak-brief">
      <div><dt>为何问</dt><dd><Clamp text={ask.why} className="ak-clamp" moreClassName="ak-more" /></dd></div>
      <div><dt>答后</dt><dd>{outcome.answered}</dd></div>
      <div><dt>不答</dt><dd>{outcome.unanswered}</dd></div>
    </dl>
    {sources.length > 0 && <p className="ak-sources"><span>来源</span>{sources.map((source) =>
      <a key={source.href} href={source.href} {...(source.href.startsWith("/api/") ? { target: "_blank", rel: "noreferrer" } : {})}>{source.label}</a>)}</p>}
    {ask.progress && <AgentProgressView progress={ask.progress} />}
    {ask.risks && <div className="ak-risks"><RiskList risks={ask.risks} gen /></div>}
    {ask.preview && <PreviewToggle href={ask.preview.href} label={ask.preview.label} data={preview} />}

    {many
      ? <fieldset className="ask-options ak-many" disabled={busy}>
        <legend className="ak-legend">可多选</legend>
        {answerable.map((option) => <label key={option.id} className="ask-option ak-check" data-checked={picked.includes(option.id) || undefined}>
          <input type="checkbox" checked={picked.includes(option.id)} onChange={() => toggle(option)} />
          <span><b>{option.label}{option.recommended && <span className="ask-recommended"> · 推荐</span>}</b>{option.detail && <small>{option.detail}</small>}</span>
        </label>)}
        {links.map((option) => <OptionLink key={option.id} option={option} />)}
      </fieldset>
      : <div className="ask-options" role="group" aria-label="选一项">
        {answerable.map((option) => <button key={option.id} type="button" className="ask-option" disabled={busy} aria-pressed={picked.includes(option.id)}
          onClick={() => chooseOne(option)}>
          <b>{option.label}{option.recommended && <span className="ask-recommended"> · 推荐</span>}</b>{option.detail && <small>{option.detail}</small>}
        </button>)}
        {links.map((option) => <OptionLink key={option.id} option={option} />)}
      </div>}

    {fields.length > 0 && <div className="ask-follow-up">
      {fields.map((field) => <FieldInput key={field.id} field={field} value={values[field.id] ?? ""}
        onChange={(value) => setValues((current) => ({ ...current, [field.id]: value }))} />)}
    </div>}

    {ask.freeText && <label className="ak-free"><span className="sr-only">用自己的话回答</span>
      <textarea rows={1} value={note} maxLength={4000} placeholder={ask.freeText.placeholder} data-user-text
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && note.trim()) { event.preventDefault(); submit(picked); }
        }} />
    </label>}

    {(many || fields.length > 0 || note.trim()) && <div className="execution-actions ak-submit">
      <button type="button" className="primary-button" disabled={busy || (!picked.length && !note.trim())} onClick={() => {
        const missing = fields.find((field) => field.required && !(values[field.id] ?? "").trim());
        if (missing) { setStatus(`「${missing.label}」未填写`); return; }
        submit(picked);
      }}>{many ? `确定${picked.length ? `（${picked.length} 项）` : ""}` : chosen[0] ? `确定：${chosen[0].label}` : "提交"}</button>
      {!many && chosen.length > 0 && <button type="button" className="secondary-button" onClick={() => { setPicked([]); setValues({}); }}>换一个</button>}
    </div>}

    <p className="ask-later">
      <button type="button" className="text-button" disabled={busy} onClick={() => void send("/api/asks/snooze", { askId: ask.id, choice: "tomorrow", seconds: seconds() })}>明天再问</button>
      <button type="button" className="text-button" disabled={busy} onClick={() => void send("/api/asks/snooze", { askId: ask.id, choice: "week", seconds: seconds() })}>下周再问</button>
      {status && <small role="status">{status}</small>}
    </p>
  </li>;
}

const uniqueFields = (fields: AskField[]) => fields.filter((field, index) => fields.findIndex((other) => other.id === field.id) === index);

function OptionLink({ option }: { option: AskOption }) {
  return <a className="ask-option ak-link" href={option.href}><b>{option.label} →</b>{option.detail && <small>{option.detail}</small>}</a>;
}

function FieldInput({ field, value, onChange }: { field: AskField; value: string; onChange: (value: string) => void }) {
  return <label>{field.label}{field.required ? "" : "（可选）"}
    {field.kind === "longtext"
      ? <textarea rows={2} required={field.required} value={value} placeholder={field.placeholder} onChange={(event) => onChange(event.target.value)} />
      : <input type={field.kind === "date" ? "date" : "text"} required={field.required} value={value} placeholder={field.placeholder}
        onChange={(event) => onChange(event.target.value)} />}
  </label>;
}

/** Urgency, the deadline it bears on, the milestone's weight (drawn), and — for one that can wait — the day it comes into the week. */
export function AskMeta({ ask }: { ask: Ask }) {
  return <p className="ask-meta">
    <Tag tone={ask.urgency === "now" ? "info" : "neutral"}>{URGENCY[ask.urgency]}</Tag>
    {ask.dueDay && <small>关系到 {shortDay(ask.dueDay)} 的截止</small>}
    {ask.importance !== undefined && <small className="ak-weight" title={`里程碑重要性 ${ask.importance} / 100`}>
      <svg viewBox="0 0 40 6" width="40" height="6" aria-hidden="true"><rect width="40" height="6" className="ak-weight-bg" />
        <rect width={Math.max(0, Math.min(100, ask.importance)) * 0.4} height="6" className="ak-weight-fill" /></svg>
      里程碑重要性 {ask.importance}</small>}
    {ask.entersOn && <small>{ask.entersOn.slice(5)} 起列入本周</small>}
  </p>;
}

/**
 * The thing the question is about, opened in place: a summary built from the ledger (the portrait's type and figure, the drafts, the
 * task's steps, the file's opening) that unfolds and folds with a short transition, plus the link to the page itself.
 */
function PreviewToggle({ href, label, data }: { href: string; label: string; data: AskPreviewData | undefined }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const external = href.startsWith("/api/");
  return <div className="ak-preview-wrap">
    <p className="ak-preview-bar">
      {data && <button type="button" className="text-button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        {open ? "收起预览" : "预览"}：{label}</button>}
      <a href={href} {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>{data ? "打开" : `打开：${label}`} →</a>
    </p>
    {data && <div id={id} className="ak-preview" data-open={open || undefined} inert={!open} aria-hidden={!open}>
      <div className="ak-preview-inner"><PreviewBody data={data} /></div>
    </div>}
  </div>;
}

const STATUS: Record<string, string> = { draft: "草稿", approved: "已批准", archived: "已归档" };

export function PreviewBody({ data }: { data: AskPreviewData }): ReactNode {
  switch (data.kind) {
    case "portrait": return <div className="ak-pv-portrait">
      {data.image && <img src={data.image} alt="画像人物" width={96} height={144} loading="lazy" />}
      <div>
        {data.code && <p className="ak-pv-type"><b>{data.code}</b> {data.name}</p>}
        {data.tagline && <p className="gen">{data.tagline}</p>}
        {data.summary && <p className="gen ak-pv-summary">{data.summary}</p>}
        {data.keywords.length > 0 && <p className="ak-pv-tags">{data.keywords.map((word) => <Tag key={word}>{word}</Tag>)}</p>}
      </div>
    </div>;
    case "milestones": return <ol className="ak-pv-list">{data.items.map((item, index) => <li key={index} data-line={item.line}>
      <span className="gen">{item.title}</span><small>{item.deadline ? shortDay(item.deadline) : "未定日期"} · {STATUS[item.status]}</small></li>)}</ol>;
    case "task": return <div className="ak-pv-task">
      <p><b>{data.title}</b> <Tag>{data.state}</Tag>{data.due && <small> 截止 {shortDay(data.due)}</small>}</p>
      {data.steps.length > 0 && <ol className="ak-pv-list">{data.steps.map((step, index) => <li key={index} data-done={step.done || undefined}>
        <span className="gen">{step.title}</span><small>{step.done ? "已完成" : "未完成"}</small></li>)}</ol>}
    </div>;
    case "file": return <div className="ak-pv-file"><p><b>{data.fileName}</b></p>{data.excerpt && <p className="gen ak-pv-summary">{data.excerpt}</p>}</div>;
  }
}

/**
 * Where an assistant run stopped: what it was doing, the steps it finished (drawn as filled cells, the one it stopped at hatched), why it
 * stopped, and what only the person can supply for it to go on. A retry that could act outside this machine is flagged.
 */
export function AgentProgressView({ progress }: { progress: AskProgress }) {
  const total = progress.done.length + 1;
  return <section className="ak-progress" aria-label="助手进度">
    {progress.summary && <p className="gen">{progress.summary}</p>}
    <div className="ak-progress-head">
      <div className="ak-progress-bar" role="img" aria-label={`已完成 ${progress.done.length} 步，停在第 ${total} 步`}>
        {progress.done.map((step, index) => <span key={index} className="ak-cell" data-state="done" title={step} />)}
        <span className="ak-cell" data-state="stuck" title={progress.stuckAt} />
      </div>
      <small>已完成 {progress.done.length} 步 · 停在第 {total} 步{progress.retries > 0 ? ` · 已自动重试 ${progress.retries} 次` : ""}</small>
    </div>
    <ol className="ak-steps">
      {progress.done.map((step, index) => <li key={index} data-state="done"><span aria-hidden="true">✓</span><span className="gen">{step}</span></li>)}
      <li data-state="stuck"><span aria-hidden="true">■</span><span><b>停在</b> <span className="gen">{progress.stuckAt}</span></span></li>
    </ol>
    {progress.needs.length > 0 && <div className="ak-needs"><h4>需本人决定或提供</h4>
      <ul>{progress.needs.map((item, index) => <li key={index} className="gen">{item}</li>)}</ul></div>}
    {progress.external && <p className="ak-external"><Tag tone="warn">涉及外部</Tag> 重试可能在本机之外产生动作（登录、付费或发送），需本人确认后再继续。</p>}
  </section>;
}
