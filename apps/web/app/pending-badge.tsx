"use client";

import { useEffect, useState } from "react";
import { pollWhileVisible } from "./ui/visible-poll";
import { useT } from "./locale-context";

/** Fired by anything that answers a decision without reloading the page, so the badge counts again at once. */
export const PENDING_CHANGED = "crossline:pending-changed";

/** The number of things waiting for a decision. Renders nothing until it has a real answer and nothing at zero. */
export function PendingBadge() {
  const t = useT();
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
  return count > 0 ? <b className="pending-badge" aria-label={t("{{count}} 项待确认", { count })}>{count}</b> : null;
}
