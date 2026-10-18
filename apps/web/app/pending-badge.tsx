"use client";

import { useEffect, useState } from "react";
import { pollWhileVisible } from "./ui/visible-poll";

/** Fired by anything that answers a decision without reloading the page, so the badge counts again at once. */
export const PENDING_CHANGED = "crossline:pending-changed";

/** The number of things waiting for a decision. Renders nothing until it has a real answer and nothing at zero. */
export function PendingBadge() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let live = true;
    const look = async () => {
      const response = await fetch("/api/pending", { cache: "no-store" }).catch(() => undefined);
      const body = await response?.json().catch(() => undefined) as { total?: number } | undefined;
      if (live && typeof body?.total === "number") setCount(body.total);
    };
    const stop = pollWhileVisible(look, 60_000);
    const changed = () => void look();
    window.addEventListener(PENDING_CHANGED, changed);
    return () => { live = false; stop(); window.removeEventListener(PENDING_CHANGED, changed); };
  }, []);
  return count > 0 ? <b className="pending-badge" aria-label={`${count} 项待确认`}>{count}</b> : null;
}

/**
 * The same count inside running text (待确认's 「本周 N 项待决定」): it was rendered once on the server and kept the old number after an
 * answer on the page, while the badge beside it had already moved (2026-10-18 walkthrough).
 */
export function LivePendingCount({ initial }: { initial: number }) {
  const [count, setCount] = useState(initial);
  useEffect(() => {
    let live = true;
    const changed = async () => {
      const response = await fetch("/api/pending", { cache: "no-store" }).catch(() => undefined);
      const body = await response?.json().catch(() => undefined) as { total?: number } | undefined;
      if (live && typeof body?.total === "number") setCount(body.total);
    };
    const listener = () => void changed();
    window.addEventListener(PENDING_CHANGED, listener);
    return () => { live = false; window.removeEventListener(PENDING_CHANGED, listener); };
  }, []);
  return <>{count}</>;
}
