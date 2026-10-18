"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * A one-paragraph newcomer note on a page whose controls do not explain themselves (the 2026-10-18 walkthrough). It is shown until the
 * person presses 「知道了」, which is remembered in this browser only — a per-viewer convenience, so it is safe to lose: a private
 * window simply shows the note again. Rendered only after mount, so the server's HTML and the first client render agree.
 */
export function FirstHint({ id, title, children }: { id: string; title?: string; children: ReactNode }) {
  const key = `crossline.hint.${id}`;
  const [shown, setShown] = useState(false);
  useEffect(() => {
    try { setShown(localStorage.getItem(key) !== "1"); } catch { setShown(true); }
  }, [key]);
  if (!shown) return null;
  const dismiss = () => {
    setShown(false);
    try { localStorage.setItem(key, "1"); } catch { /* storage blocked: the note returns next visit */ }
  };
  return <aside className="ui-first-hint" role="note" data-hint={id}>
    <div>
      {title ? <strong>{title}</strong> : null}
      <div>{children}</div>
    </div>
    <button type="button" onClick={dismiss}>知道了</button>
  </aside>;
}
