"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { Ask } from "@crossline/core";
import { PENDING_CHANGED } from "../pending-badge";
import { AskCard } from "./ask-card";
import { uniqueAsks } from "./model";
import type { AskPreviews } from "./types";
import { useT } from "../locale-context";
import { Receipt } from "../ui/vanish";

/**
 * The open asks, kept current after each answer: the answered one leaves at once, and the list is fetched again, because an answer can
 * resolve or raise others (handing over a missing input re-plans the milestone). `keep` picks which of them this view shows.
 * Where it stood, a one-line receipt 「已执行 · 撤销」 says so for a moment (`receipts`, one-shot cards vanish, 2026-11-10).
 */
export function useAskList(initial: Ask[], keep: (ask: Ask) => boolean) {
  const t = useT();
  const [asks, setAsks] = useState(() => uniqueAsks(initial.filter(keep)));
  const reload = async () => {
    const response = await fetch("/api/asks", { cache: "no-store" }).catch(() => null);
    const body = await response?.json().catch(() => null) as { asks?: Ask[] } | null;
    if (body?.asks) setAsks(uniqueAsks(body.asks.filter(keep)));
  };
  const [done, setDone] = useState<Array<{ id: string; opIds: string[] }>>([]);
  const onDone = (id: string, opId?: string) => {
    setAsks((list) => list.filter((item) => item.id !== id));
    setDone((list) => [...list, { id, opIds: opId ? [opId] : [] }]);
    window.dispatchEvent(new Event(PENDING_CHANGED));
  };
  const receipts = done.length ? <div className="ask-receipts">{done.map((item) => <Receipt key={item.id} opIds={item.opIds} text={t("已处理")}
    onGone={() => setDone((list) => list.filter((entry) => entry.id !== item.id))} onUndone={() => void reload()} />)}</div> : null;
  // Answered here or anywhere else on the page (the day's opener, the input box): the list is fetched again.
  useEffect(() => {
    const onChanged = () => void reload();
    window.addEventListener(PENDING_CHANGED, onChanged);
    return () => window.removeEventListener(PENDING_CHANGED, onChanged);
  });
  return { asks, onDone, receipts };
}

/** Which card of a stack is on top. Stays in range as the stack shrinks. */
export function useDeck(count: number) {
  const [index, setIndex] = useState(0);
  const at = Math.max(0, Math.min(index, count - 1));
  const go = (step: number) => setIndex(Math.max(0, Math.min(count - 1, at + step)));
  return { at, go, pick: setIndex };
}

/** ‹ n / m › for a stack, plus anything the caller puts after it (a link to the full list). */
export function DeckNav({ at, count, go, label, children }: { at: number; count: number; go: (step: number) => void; label: string; children?: ReactNode }) {
  const t = useT();
  if (count < 2 && !children) return null;
  return <nav className="ask-stack-nav" aria-label={label}>
    {count > 1 && <>
      <button type="button" className="text-button" aria-label={t("上一项")} disabled={at === 0} onClick={() => go(-1)}>‹</button>
      <span className="mono" aria-live="polite">{at + 1} / {count}</span>
      <button type="button" className="text-button" aria-label={t("下一项", { context: "button" })} disabled={at === count - 1} onClick={() => go(1)}>›</button>
    </>}
    {children}
  </nav>;
}

/**
 * A drawer of asks: the top one open, the next two as edges beneath it (clicking one brings it up). Answering the top one brings up the
 * next by itself.
 */
export function AskDeck({ asks, at, pick, onDone, previews, level, keys = false }: {
  asks: Ask[]; at: number; pick: (index: number) => void; onDone: (id: string, opId?: string) => void; previews?: AskPreviews | undefined; level?: 3 | 4;
  /** The top card answers to number keys, Enter and H (待确认). */
  keys?: boolean;
}) {
  const top = asks[at];
  if (!top) return null;
  const below = asks.slice(at + 1, at + 3);
  return <div className="ak-deck">
    <ol className="ask-deck"><AskCard key={top.id} ask={top} preview={previews?.[top.id]} onDone={onDone} keys={keys} {...(level ? { level } : {})} /></ol>
    {below.map((ask, depth) => <button key={ask.id} type="button" className="ask-peek" data-depth={depth + 1} data-line={ask.line}
      onClick={() => pick(at + depth + 1)}>{ask.title}</button>)}
  </div>;
}
