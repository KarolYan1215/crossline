"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The invitation link with 「复制链接」 always and 「分享」 where the system share sheet exists. A dismissed share sheet is not an error;
 * a refused clipboard falls back to selecting the text so it can be copied by hand. The outcome is announced politely.
 */
export function ShareInvite({ url, title, text }: { url: string; title: string; text: string }) {
  const field = useRef<HTMLInputElement>(null);
  const [canShare, setCanShare] = useState(false);
  const [status, setStatus] = useState("");
  useEffect(() => { setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function"); }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setStatus("链接已复制，发给朋友吧。");
      return;
    } catch { /* fall through to selecting the text */ }
    field.current?.focus();
    field.current?.select();
    let copied = false;
    try { copied = document.execCommand("copy"); } catch { copied = false; }
    setStatus(copied ? "链接已复制，发给朋友吧。" : "已选中链接，请长按或按 Ctrl+C 复制。");
  };
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
