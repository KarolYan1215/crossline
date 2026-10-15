"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

/** Copies a link; a refused clipboard falls back to selecting the text so it can be copied by hand. Answers the status line to show. */
async function copyLink(url: string, field: RefObject<HTMLInputElement | null>, done: string): Promise<string> {
  try {
    await navigator.clipboard.writeText(url);
    return done;
  } catch { /* fall through to selecting the text */ }
  field.current?.focus();
  field.current?.select();
  let copied = false;
  try { copied = document.execCommand("copy"); } catch { copied = false; }
  return copied ? done : "已选中链接，请长按或按 Ctrl+C 复制。";
}

/**
 * The invitation link with 「复制链接」 always and 「分享」 where the system share sheet exists. A dismissed share sheet is not an error.
 * The outcome is announced politely.
 */
export function ShareInvite({ url, title, text }: { url: string; title: string; text: string }) {
  const field = useRef<HTMLInputElement>(null);
  const [canShare, setCanShare] = useState(false);
  const [status, setStatus] = useState("");
  useEffect(() => { setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function"); }, []);

  const copy = async () => setStatus(await copyLink(url, field, "链接已复制，发给朋友吧。"));
  const share = async () => {
    try {
      await navigator.share({ title, text, url });
      setStatus("");
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      await copy();
    }
  };

  return <div className="as-share">
    <label className="as-field">
      <span>你的邀请链接</span>
      <input ref={field} type="text" readOnly value={url} onFocus={(event) => event.currentTarget.select()} />
    </label>
    <div className="as-row">
      {canShare && <button type="button" className="as-primary" onClick={() => void share()}>分享邀请</button>}
      <button type="button" className={canShare ? undefined : "as-primary"} onClick={() => void copy()}>复制链接</button>
    </div>
    <p className="as-note" aria-live="polite">{status}</p>
  </div>;
}

/** A link to keep for oneself (the result's own address when no mail carries it): the text and 「复制」. */
export function CopyLink({ url, label }: { url: string; label: string }) {
  const field = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState("");
  return <div className="as-share">
    <label className="as-field">
      <span>{label}</span>
      <input ref={field} type="text" readOnly value={url} onFocus={(event) => event.currentTarget.select()} />
    </label>
    <div className="as-row">
      <button type="button" onClick={async () => setStatus(await copyLink(url, field, "已复制，存到备忘录或收藏里。"))}>复制</button>
    </div>
    <p className="as-note" aria-live="polite">{status}</p>
  </div>;
}
