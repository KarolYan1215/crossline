"use client";

import { useEffect, useState } from "react";
import type { Ask, AskOption } from "@crossline/core";
import { PENDING_CHANGED } from "./pending-badge";

const URGENCY: Record<Ask["urgency"], string> = { now: "今天要答", soon: "这周", later: "不急" };

/**
 * The system's questions, a few at a time: each with its options already written (the recommended one marked), a
 * follow-up form when an option needs specifics (pick 「在等」 and it asks who and roughly when), and 「明天再问」 /
 * 「下周再问」. Answering one takes it off the list and the next comes up without reloading the page — the list itself is
 * fetched again, because an answer can resolve or raise others (handing over a missing input re-plans the milestone).
 */
type Scope = "week" | "later";
const inScope = (scope: Scope) => (ask: Ask) => scope === "later" ? Boolean(ask.entersOn) : !ask.entersOn;

/** The asks of one scope (this week's, or those that can wait), kept current after each answer. */
function useAsks(initial: Ask[], scope: Scope) {
  const [asks, setAsks] = useState(() => initial.filter(inScope(scope)));
  const reload = async () => {
    const response = await fetch("/api/asks", { cache: "no-store" }).catch(() => null);
    const body = await response?.json().catch(() => null) as { asks?: Ask[] } | null;
    if (body?.asks) setAsks(body.asks.filter(inScope(scope)));
  };
  const onDone = (id: string) => {
    setAsks((list) => list.filter((item) => item.id !== id));
    window.dispatchEvent(new Event(PENDING_CHANGED));
    void reload();
  };
  return { asks, onDone };
}

/** The full list, on 待确认: this week's asks, or (`scope="later"`) those whose decision can wait, each with the day it comes up. */
export function AskList({ initial, scope = "week", heading = "待决事项" }: { initial: Ask[]; scope?: Scope; heading?: string }) {
  const { asks, onDone } = useAsks(initial, scope);
  if (!asks.length) return null;
  return <section className="ask-list" id={scope === "later" ? "later-asks" : "asks"} aria-label={heading}>
    <header><h2>{heading} · {asks.length}</h2></header>
    <ol>{asks.map((ask) => <AskCard key={ask.id} ask={ask} onDone={onDone} />)}</ol>
  </section>;
}

/**
 * Today's asks as a stack (decided 2026-10-10): only the top one open, the next two as edges beneath it, most urgent first and, at
 * equal urgency, the more important milestone's first. Answering the top one brings up the next; ‹ › and the left and right arrow keys
 * (anywhere on the page, except while typing, on a slider or in a dialog) move through the stack without answering.
 */
export function AskStack({ initial, moreHref }: { initial: Ask[]; moreHref?: string }) {
  const { asks, onDone } = useAsks(initial, "week");
  const [index, setIndex] = useState(0);
  const count = asks.length;
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable || target.closest('[role="slider"],[role="dialog"],dialog'))) return;
      if (document.querySelector("dialog[open]")) return;
      event.preventDefault();
      setIndex((current) => Math.max(0, Math.min(count - 1, Math.min(current, count - 1) + (event.key === "ArrowRight" ? 1 : -1))));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count]);
  if (!count) return null;
  const at = Math.min(index, count - 1);
  const go = (step: number) => setIndex(Math.max(0, Math.min(count - 1, at + step)));
  const top = asks[at]!;
  const below = asks.slice(at + 1, at + 3);
  return <section className="ask-list ask-stack" id="asks" aria-label="待决事项">
    <header><h2>待决事项 · {asks.length}</h2>
      <nav className="ask-stack-nav" aria-label="切换待决事项">
        <button type="button" className="text-button" aria-label="上一项" disabled={at === 0} onClick={() => go(-1)}>‹</button>
        <span className="mono" aria-live="polite">{at + 1} / {count}</span>
        <button type="button" className="text-button" aria-label="下一项" disabled={at === count - 1} onClick={() => go(1)}>›</button>
        {moreHref && <a href={moreHref}>全部</a>}
      </nav></header>
    <ol className="ask-deck"><AskCard key={top.id} ask={top} onDone={onDone} /></ol>
    {below.map((ask, depth) => <button key={ask.id} type="button" className="ask-peek" data-depth={depth + 1} data-line={ask.line}
      onClick={() => setIndex(at + depth + 1)}>{ask.title}</button>)}
  </section>;
}

function AskMeta({ ask }: { ask: Ask }) {
  return <p className="ask-meta"><span className="tag">{URGENCY[ask.urgency]}</span>{ask.dueDay && <small>关系到 {ask.dueDay.slice(5)} 的截止</small>}
    {ask.importance !== undefined && <small>里程碑重要性 {ask.importance}</small>}{ask.entersOn && <small>{ask.entersOn.slice(5)} 起列入本周</small>}</p>;
}

function AskCard({ ask, onDone }: { ask: Ask; onDone: (id: string) => void }) {
  const [chosen, setChosen] = useState<AskOption | undefined>();
  const [values, setValues] = useState<Record<string, string>>({});
  const [status, setStatus] = useState("");
  const post = async (path: string, body: Record<string, unknown>) => {
    setStatus("保存中…");
    const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const result = await response?.json().catch(() => null) as { ok?: boolean; code?: string } | null;
    if (result?.ok) { onDone(ask.id); return; }
    setStatus(result?.code === "ASK_FIELD_REQUIRED" ? "还有必填的没写" : result?.code === "ASK_NOT_FOUND" ? "这条已经处理过了" : "没保存上，请重试");
  };
  const choose = (option: AskOption) => {
    if (option.fields?.length) {
      setChosen(option);
      setValues(Object.fromEntries(option.fields.filter((field) => field.initial).map((field) => [field.id, field.initial!])));
      return;
    }
    void post("/api/asks/answer", { askId: ask.id, optionId: option.id, values: {} });
  };
  return <li className="ask-card" data-line={ask.line} data-urgency={ask.urgency}>
    <AskMeta ask={ask} /><h3>{ask.title}</h3>
    <p className="ask-why">{ask.why}</p>
    <div className="ask-options" role="group" aria-label="选一个">
      {ask.options.map((option) => option.href
        ? <a key={option.id} className="ask-option" href={option.href}><b>{option.label}</b>{option.detail && <small>{option.detail}</small>}</a>
        : <button key={option.id} type="button" className="ask-option" aria-pressed={chosen?.id === option.id} onClick={() => choose(option)}>
          <b>{option.label}{option.recommended && <span className="ask-recommended"> · 推荐</span>}</b>{option.detail && <small>{option.detail}</small>}
        </button>)}
    </div>
    {chosen && <form className="ask-follow-up" onSubmit={(event) => { event.preventDefault(); void post("/api/asks/answer", { askId: ask.id, optionId: chosen.id, values }); }}>
      {chosen.fields!.map((field) => <label key={field.id}>{field.label}{field.required ? "" : "（可选）"}
        {field.kind === "longtext"
          ? <textarea rows={3} required={field.required} value={values[field.id] ?? ""} placeholder={field.placeholder}
            onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))} />
          : <input type={field.kind === "date" ? "date" : "text"} required={field.required} value={values[field.id] ?? ""} placeholder={field.placeholder}
            onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))} />}
      </label>)}
      <div className="execution-actions"><button type="submit" className="primary-button">确定：{chosen.label}</button>
        <button type="button" onClick={() => setChosen(undefined)}>换一个</button></div>
    </form>}
    <p className="ask-later">
      <button type="button" className="text-button" onClick={() => void post("/api/asks/snooze", { askId: ask.id, choice: "tomorrow" })}>明天再问</button>
      <button type="button" className="text-button" onClick={() => void post("/api/asks/snooze", { askId: ask.id, choice: "week" })}>下周再问</button>
      {status && <small role="status">{status}</small>}
    </p>
  </li>;
}
