"use client";

import { useState, type ReactNode } from "react";
import type { Ask } from "@crossline/core";
import { PENDING_CHANGED } from "../pending-badge";
import { AskCard } from "./ask-card";
import { uniqueAsks } from "./model";
import type { AskPreviews } from "./types";

/**
 * The open asks, kept current after each answer: the answered one leaves at once, and the list is fetched again, because an answer can
 * resolve or raise others (handing over a missing input re-plans the milestone). `keep` picks which of them this view shows.
 */
export function useAskList(initial: Ask[], keep: (ask: Ask) => boolean) {
  const [asks, setAsks] = useState(() => uniqueAsks(initial.filter(keep)));
  const reload = async () => {
    const response = await fetch("/api/asks", { cache: "no-store" }).catch(() => null);
    const body = await response?.json().catch(() => null) as { asks?: Ask[] } | null;
    if (body?.asks) setAsks(uniqueAsks(body.asks.filter(keep)));
  };
  const onDone = (id: string) => {
    setAsks((list) => list.filter((item) => item.id !== id));
    window.dispatchEvent(new Event(PENDING_CHANGED));
    void reload();
  };
  return { asks, onDone };
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
  if (count < 2 && !children) return null;
  return <nav className="ask-stack-nav" aria-label={label}>
    {count > 1 && <>
      <button type="button" className="text-button" aria-label="上一项" disabled={at === 0} onClick={() => go(-1)}>‹</button>
      <span className="mono" aria-live="polite">{at + 1} / {count}</span>
      <button type="button" className="text-button" aria-label="下一项" disabled={at === count - 1} onClick={() => go(1)}>›</button>
    </>}
    {children}
  </nav>;
}

/**
 * A drawer of asks: the top one open, the next two as edges beneath it (clicking one brings it up). Answering the top one brings up the
 * next by itself.
 */
export function AskDeck({ asks, at, pick, onDone, previews, level }: {
  asks: Ask[]; at: number; pick: (index: number) => void; onDone: (id: string) => void; previews?: AskPreviews | undefined; level?: 3 | 4;
}) {
  const top = asks[at];
  if (!top) return null;
  const below = asks.slice(at + 1, at + 3);
  return <div className="ak-deck">
    <ol className="ask-deck"><AskCard key={top.id} ask={top} preview={previews?.[top.id]} onDone={onDone} {...(level ? { level } : {})} /></ol>
    {below.map((ask, depth) => <button key={ask.id} type="button" className="ask-peek" data-depth={depth + 1} data-line={ask.line}
      onClick={() => pick(at + depth + 1)}>{ask.title}</button>)}
  </div>;
}
