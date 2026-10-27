"use client";

import { useEffect, useState } from "react";
import { pollWhileVisible } from "./ui/visible-poll";
import { useT } from "./locale-context";

/** Fired by anything that answers a decision without reloading the page, so the badge counts again at once. */
export const PENDING_CHANGED = "crossline:pending-changed";

/**
 * The part of `/api/pending` the screen shows. `total` is 「待确认」 (everything this week that waits on the person: asks, task proposals,
 * the assistant's results, drafts…); `asks` is 「待决事项」, the questions alone, which Today's stack and 待确认's four quadrants list.
 */
export type PendingView = { total: number; asks: number; later: number };

/**
 * One reading shared by every count on the page. The header badge, the phone's 「更多」 badge, Today's stack and the day panel each
 * fetched `/api/pending` on their own clock, so for a moment after an answer they could show different numbers side by side
 * (2026-10-21 walkthrough). Now there is one poll and one fetch in flight, and every subscriber gets the same answer.
 */
let latest: PendingView | undefined;
const listeners = new Set<(view: PendingView) => void>();
let inflight: Promise<void> | undefined;
let stop: (() => void) | undefined;

export function pendingViewOf(body: unknown): PendingView | undefined {
  const value = body as { total?: unknown; asks?: unknown; later?: { total?: unknown } } | null | undefined;
  if (typeof value?.total !== "number") return undefined;
  return { total: value.total, asks: typeof value.asks === "number" ? value.asks : 0,
    later: typeof value.later?.total === "number" ? value.later.total : 0 };
}

function refresh(): Promise<void> {
  inflight ??= (async () => {
    const response = await fetch("/api/pending", { cache: "no-store" }).catch(() => undefined);
    const view = pendingViewOf(await response?.json().catch(() => undefined));
    if (view) { latest = view; for (const listener of listeners) listener(view); }
  })().finally(() => { inflight = undefined; });
  return inflight;
}

const onChanged = () => void refresh();

/** The shared reading; `undefined` until the first answer arrives. */
export function usePendingView(): PendingView | undefined {
  const [view, setView] = useState<PendingView | undefined>(latest);
  useEffect(() => {
    listeners.add(setView);
    if (listeners.size === 1) {
      stop = pollWhileVisible(refresh, 60_000);
      window.addEventListener(PENDING_CHANGED, onChanged);
    } else if (latest) setView(latest);
    return () => {
      listeners.delete(setView);
      if (!listeners.size) { stop?.(); stop = undefined; window.removeEventListener(PENDING_CHANGED, onChanged); }
    };
  }, []);
  return view;
}

/** The number of things waiting for a decision. Renders nothing until it has a real answer and nothing at zero. */
export function PendingBadge() {
  const t = useT();
  const count = usePendingView()?.total ?? 0;
  return count > 0 ? <b className="pending-badge" aria-label={t("{{count}} 项待确认", { count })} title={t("待确认 {{count}} 项：待决事项、任务提案、助手成果等", { count })}>{count}</b> : null;
}

/**
 * The same count inside running text (待确认's 「本周 N 项待确认」): it was rendered once on the server and kept the old number after an
 * answer on the page, while the badge beside it had already moved (2026-10-18 walkthrough). `field` picks which count.
 */
export function LivePendingCount({ initial, field = "total" }: { initial: number; field?: "total" | "asks" }) {
  const view = usePendingView();
  return <>{view ? view[field] : initial}</>;
}

/** Where the bold number goes in a translated sentence: the sentence stays one key and is split around it (docs/i18n.md). */
const MARK = "\u0000";

/** 「待确认共 N →」: the link from a list of asks to the whole of 待确认, saying how much more waits there than the asks alone. */
export function PendingTotalLink({ href = "/approvals" }: { href?: string }) {
  const t = useT();
  const view = usePendingView();
  const [before = "", after = ""] = t("待确认共 {{n}} →", { n: MARK }).split(MARK);
  return <a href={href} className="pending-total-link" title={t("待确认包括待决事项、任务提案、助手成果等，与顶栏徽标同一个数")}>
    {view ? <>{before}<b className="mono">{view.total}</b>{after}</> : t("全部待确认 →")}
  </a>;
}
