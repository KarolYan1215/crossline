"use client";

import type { Ask } from "@crossline/core";
import { AskCard } from "./asks/ask-card";
import { useAskList } from "./asks/ask-drawer";
import type { AskPreviews } from "./asks/types";
import { useT } from "./locale-context";

/**
 * The system's questions, a few at a time: each says what is asked, why, what an answer does and what silence does, with its options
 * already written (the recommended one marked), a follow-up form when an option needs specifics (pick 「在等」 and it asks who and
 * roughly when), and 「明天再问」 / 「下周再问」. The card and the drawer are shared with 待确认 (`asks/`). Today lists them in its
 * 「需要处理」 card (`today/needs-card.tsx`) since 2026-10-28; the stack that used to sit there is gone.
 */
type Scope = "week" | "later";
const inScope = (scope: Scope) => (ask: Ask) => scope === "later" ? Boolean(ask.entersOn) : !ask.entersOn;

/** A plain list: on 待确认, the asks whose decision can wait (`scope="later"`), each with the day it comes up. */
export function AskList({ initial, scope = "week", heading = "待决事项", previews }: { initial: Ask[]; scope?: Scope; heading?: string; previews?: AskPreviews }) {
  const t = useT();
  const { asks, onDone } = useAskList(initial, inScope(scope));
  if (!asks.length) return null;
  // `heading` is a Chinese key (or already translated, which `t` returns as it is).
  return <section className="ask-list" id={scope === "later" ? "later-asks" : "asks"} aria-label={t(heading)}>
    <header><h2>{t(heading)} · {asks.length}</h2></header>
    <ol className="ak-list">{asks.map((ask) => <AskCard key={ask.id} ask={ask} preview={previews?.[ask.id]} onDone={onDone} />)}</ol>
  </section>;
}
