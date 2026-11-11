"use client";

import { useEffect, useRef } from "react";
import { useT } from "../locale-context";

/** How long a done card's receipt stays before the card is gone (2026-11-10). */
export const RECEIPT_MS = 1500;

/**
 * What a one-shot card leaves when it is done: one line for about 1.5 s, with 撤销 where the step can be taken back, then nothing.
 * Pressing 撤销 cancels the timer; the caller puts the card back.
 */
export function Receipt({ text, onUndo, onDone }: { text: string; onUndo?: (() => void) | undefined; onDone: () => void }) {
  const t = useT();
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    const timer = setTimeout(() => done.current(), RECEIPT_MS);
    return () => clearTimeout(timer);
  }, []);
  return <p className="ob-receipt" role="status">
    <span>{text}</span>
    {onUndo && <button type="button" className="ob-btn ob-quiet" onClick={onUndo}>{t("撤销")}</button>}
  </p>;
}
