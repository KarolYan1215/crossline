"use client";

import { Clock } from "lucide-react";
import { entryHistogram } from "../asks/model";
import { useLocale, useT } from "../locale-context";
import { shortDate } from "../task/format";
import { ICON } from "../ui/icon-button";

/**
 * 「以后再定」 in 待确认's left column (2026-10-29): how many decisions can wait and when they come into the week — one bar per day over four
 * weeks, hovering gives the day and count. Pressing it opens the fold at the foot of the deck, where they are listed.
 */
export function LaterLink({ later, today }: { later: string[]; today: string }) {
  const t = useT(), locale = useLocale();
  if (!later.length) return null;
  const shortDay = (day: string) => shortDate(locale, day);
  const bars = entryHistogram(later, today);
  const top = Math.max(1, ...bars.map((bar) => bar.count));
  const first = [...later].sort()[0];
  return <a className="ap-card ap-later" href="#later" onClick={() => { const fold = document.getElementById("later"); if (fold instanceof HTMLDetailsElement) fold.open = true; }}
    aria-label={t("以后再定 {{count}} 项，最早 {{day}} 列入本周", { count: later.length, day: first ? shortDay(first) : "" })}>
    <span className="ap-later-label"><Clock {...ICON} />{t("以后再定")} · <b className="mono">{later.length}</b>{first && <small>{t("最早 {{day}}", { day: shortDay(first) })}</small>}</span>
    <svg className="ap-later-bars" viewBox={`0 0 ${bars.length * 6} 24`} preserveAspectRatio="none" aria-hidden="true">
      {bars.map((bar, index) => <g key={bar.day}>
        <rect x={index * 6} y="0" width="5" height="24" className="ap-later-slot"><title>{t("{{day}} · {{count}} 项", { day: shortDay(bar.day), count: bar.count })}</title></rect>
        {bar.count > 0 && <rect x={index * 6} y={24 - (bar.count / top) * 22 - 2} width="5" height={(bar.count / top) * 22 + 2} className="ap-later-bar">
          <title>{t("{{day}} 列入本周 · {{count}} 项", { day: shortDay(bar.day), count: bar.count })}</title></rect>}
        {index % 7 === 0 && <rect x={index * 6} y="22" width="1" height="2" className="ap-later-tick" />}
      </g>)}
    </svg>
  </a>;
}

/**
 * 「不在这里处理」 (scenarios.md §3.8 and the matrix): what waits for the person but is decided where it lives — the interview's questions,
 * milestone drafts and score lines on 主线, research and candidate relations in the weekly review, dates read from files in the interview.
 * Each is a count and a link; nothing is drawn for a count of zero.
 */
export function ElsewhereCard({ items }: { items: Array<{ label: string; count: number; href: string; go: string }> }) {
  const t = useT();
  const shown = items.filter((item) => item.count > 0);
  if (!shown.length) return null;
  return <section className="ap-card ap-elsewhere" aria-label={t("不在这里处理")}>
    <h2 className="ap-card-title">{t("不在这里处理")}</h2>
    <ul>{shown.map((item) => <li key={item.label}><span>{item.label} · <b className="mono">{item.count}</b></span> <a href={item.href}>{item.go}</a></li>)}</ul>
  </section>;
}
