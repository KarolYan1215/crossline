"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "../locale-context";

const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Long text on a card, cut to a few lines with 「全文」 after it, read in full in place. Used for whatever a card shows that can run long —
 * a model's summary, a reason, a description — so no card shows a wall of text by default (docs/copy-style.md, 阅读负担).
 */
export function Clamp({ text, lines = 2, className = "", moreClassName = "" }: { text: string; lines?: number; className?: string; moreClassName?: string }) {
  const t = useT();
  const ref = useRef<HTMLSpanElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  useBrowserLayoutEffect(() => {
    const element = ref.current;
    if (element && !open) setLong(element.scrollHeight > element.clientHeight + 1);
  }, [text, open]);
  return <>
    <span ref={ref} className={`clamp ${className}`.trim()} style={{ ["--clamp-lines" as string]: lines }} data-open={open || undefined}>{text}</span>
    {(long || open) && <button type="button" className={`clamp-more ${moreClassName}`.trim()} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? t("收起") : t("全文")}</button>}
  </>;
}

/**
 * The same for a block of several paragraphs (a reply drawn from Markdown): held to `lines` lines of its own text, 「全文」 below.
 */
export function ClampBlock({ lines = 3, className = "", children }: { lines?: number; className?: string; children: ReactNode }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  useBrowserLayoutEffect(() => {
    const element = ref.current;
    if (element && !open) setLong(element.scrollHeight > element.clientHeight + 1);
  }, [children, open]);
  return <>
    <div ref={ref} className={`clamp-block ${className}`.trim()} style={{ ["--clamp-lines" as string]: lines }} data-open={open || undefined}>{children}</div>
    {(long || open) && <button type="button" className="clamp-more" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? t("收起") : t("全文")}</button>}
  </>;
}
