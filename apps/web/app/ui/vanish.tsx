"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { markSeen, undoOperation } from "../undo-center";
import { useT } from "../locale-context";

/** How long a one-shot card's receipt stays before the card is gone (the owner's 2026-11-10 decision: about 1.5 s). */
export const RECEIPT_MS = 1500;

/**
 * One-shot cards vanish (2026-11-10): once a card is done or answered it shows one line 「已执行 · 撤销」 for `RECEIPT_MS`, then is removed.
 * It stays findable and undoable in 今日操作 (the undo center). The timer waits while the pointer or focus is on the line, so 撤销 can
 * be reached; after 撤销 the line says so and goes the same way. Reusable things (workflows, automations, lines, settings) never use it.
 *
 * `opIds`: the operations the card's action wrote (none: the line has no 撤销). `onGone`: the list drops the item. `onUndone`: the
 * caller refetches (an undone item may come back).
 */
export function Receipt({ opIds, onGone, onUndone, text, ms = RECEIPT_MS }: { opIds: string[]; onGone: () => void; onUndone?: () => void; text?: string; ms?: number }) {
  const t = useT();
  const [state, setState] = useState<"done" | "undoing" | "undone" | "failed">("done");
  const [message, setMessage] = useState("");
  const held = useRef(false);
  const gone = useRef(onGone);
  gone.current = onGone;
  // The global toast would offer the same 撤销 a second time.
  useEffect(() => { for (const id of opIds) markSeen(id); }, [opIds.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (state === "undoing") return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => { timer = setTimeout(() => { if (held.current) tick(); else gone.current(); }, ms); };
    tick();
    return () => clearTimeout(timer);
  }, [state, ms]);
  const undo = async () => {
    setState("undoing");
    const results = [];
    for (const id of [...opIds].reverse()) results.push(await undoOperation(id, t));
    const failed = results.find((result) => !result.ok);
    setMessage(failed ? failed.message : t("已撤销"));
    setState(failed ? "failed" : "undone");
    if (!failed) { window.dispatchEvent(new Event("crossline:op")); onUndone?.(); }
  };
  return <p className="vanish-receipt" role="status" data-state={state}
    onPointerEnter={() => { held.current = true; }} onPointerLeave={() => { held.current = false; }}
    onFocus={() => { held.current = true; }} onBlur={() => { held.current = false; }}>
    {state === "done" || state === "undoing" ? <>
      <span>{text ?? t("已执行")}</span>
      {opIds.length > 0 && <> · <button type="button" className="text-button" disabled={state === "undoing"} onClick={() => void undo()}>{t("撤销")}</button></>}
    </> : <span>{message}</span>}
  </p>;
}

/**
 * A list item that is shown until `done`, then becomes its receipt, then is gone. `done` set when the list first renders (an item that was
 * already done) skips the receipt: only what the person just did says so.
 */
export function Vanishing({ done, opIds = [], children, onUndone, as = "div", text }: { done: boolean; opIds?: string[]; children: ReactNode; onUndone?: () => void;
  as?: "div" | "li"; text?: string }) {
  const [wasDone] = useState(done);
  const [gone, setGone] = useState(done);
  useEffect(() => { if (!done) setGone(false); }, [done]);
  if (gone || (done && wasDone)) return null;
  const Tag = as;
  return <Tag className="vanishing" data-done={done ? "" : undefined}>
    {done ? <Receipt opIds={opIds} {...(text ? { text } : {})} onGone={() => setGone(true)} {...(onUndone ? { onUndone } : {})} /> : children}
  </Tag>;
}
