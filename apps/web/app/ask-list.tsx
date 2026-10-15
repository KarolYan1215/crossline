"use client";

import { useEffect } from "react";
import type { Ask } from "@crossline/core";
import { AskCard } from "./asks/ask-card";
import { AskDeck, DeckNav, useAskList, useDeck } from "./asks/ask-drawer";
import type { AskPreviews } from "./asks/types";

/**
 * The system's questions, a few at a time: each says what is asked, why, what an answer does and what silence does, with its options
 * already written (the recommended one marked), a follow-up form when an option needs specifics (pick 「在等」 and it asks who and
 * roughly when), and 「明天再问」 / 「下周再问」. The card and the drawer are shared with 待确认 (`asks/`).
 */
type Scope = "week" | "later";
const inScope = (scope: Scope) => (ask: Ask) => scope === "later" ? Boolean(ask.entersOn) : !ask.entersOn;

/** A plain list: on 待确认, the asks whose decision can wait (`scope="later"`), each with the day it comes up. */
export function AskList({ initial, scope = "week", heading = "待决事项", previews }: { initial: Ask[]; scope?: Scope; heading?: string; previews?: AskPreviews }) {
  const { asks, onDone } = useAskList(initial, inScope(scope));
  if (!asks.length) return null;
  return <section className="ask-list" id={scope === "later" ? "later-asks" : "asks"} aria-label={heading}>
    <header><h2>{heading} · {asks.length}</h2></header>
    <ol className="ak-list">{asks.map((ask) => <AskCard key={ask.id} ask={ask} preview={previews?.[ask.id]} onDone={onDone} />)}</ol>
  </section>;
}

/**
 * Today's asks as a stack (decided 2026-10-10): only the top one open, the next two as edges beneath it, most urgent first and, at
 * equal urgency, the more important milestone's first. Answering the top one brings up the next; ‹ › and the left and right arrow keys
 * (anywhere on the page, except while typing, on a slider or in a dialog) move through the stack without answering.
 */
export function AskStack({ initial, moreHref, previews }: { initial: Ask[]; moreHref?: string; previews?: AskPreviews }) {
  const { asks, onDone } = useAskList(initial, inScope("week"));
  const count = asks.length;
  const { at, go, pick } = useDeck(count);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable || target.closest('[role="slider"],[role="dialog"],dialog'))) return;
      if (document.querySelector("dialog[open]")) return;
      event.preventDefault();
      go(event.key === "ArrowRight" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  if (!count) return null;
  return <section className="ask-list ask-stack" id="asks" aria-label="待决事项">
    <header><h2>待决事项 · {count}</h2>
      <DeckNav at={at} count={count} go={go} label="切换待决事项">{moreHref && <a href={moreHref}>全部</a>}</DeckNav></header>
    <AskDeck asks={asks} at={at} pick={pick} onDone={onDone} previews={previews} />
  </section>;
}
