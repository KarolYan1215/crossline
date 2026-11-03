"use client";

import { useState } from "react";
import { useLocale, useT } from "../locale-context";
import { postWatch, type WatchView } from "../milestones/line-watches";
import { LessList, type LessView } from "../settings/opportunity-card";
import { shortDay } from "../asks/model";

export type OutOfViewFind = { id: string; title: string; organizer: string; url: string; lineId: string; deadline?: string };

/**
 * 视野外 in the weekly review (docs/opportunity-agent.md §17.3): what the weekly scout found outside the person's usual view that did
 * not have to reach the inbox, the places it proposes to watch, and this week's 少来 adjustments — each decided or undone one by one.
 */
export function OutOfView({ finds, watches, less, lines }: { finds: OutOfViewFind[]; watches: WatchView[]; less: LessView[]; lines: Record<string, string> }) {
  const t = useT(), locale = useLocale();
  const [problem, setProblem] = useState("");
  const done = (ok: boolean) => ok ? location.reload() : setProblem(t("没能保存，请稍后重试"));
  const decide = async (id: string, option: string) => {
    const response = await fetch("/api/opportunities/decide", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, option }) }).catch(() => null);
    done(Boolean(response?.ok));
  };
  return <>
    {finds.length > 0 && <><h3>{t("侦察发现")}</h3>
      <ul className="review-list">{finds.map((find) => <li key={find.id} data-line={find.lineId}>
        <b><a href={find.url} target="_blank" rel="noreferrer">{find.title}</a></b>
        <small>{[lines[find.lineId] ?? find.lineId, find.organizer, find.deadline ? t("截止 {{day}}", { day: shortDay(find.deadline, locale) }) : ""].filter(Boolean).join(" · ")}</small>
        <p className="lw-actions"><button type="button" onClick={() => void decide(find.id, "plan")}>{t("加入计划")}</button>
          <button type="button" onClick={() => void decide(find.id, "later")}>{t("以后再说")}</button>
          <button type="button" onClick={() => void decide(find.id, "less_kind")}>{t("少来这类")}</button>
          <button type="button" onClick={() => void decide(find.id, "decline")}>{t("不要")}</button></p>
      </li>)}</ul></>}
    {watches.length > 0 && <><h3>{t("提议长期盯住")}</h3>
      <ul className="review-list">{watches.map((watch) => <li key={watch.id} data-line={watch.lineId}>
        <b>{watch.title}</b><small>{[lines[watch.lineId] ?? watch.lineId, watch.why].filter(Boolean).join(" · ")}</small>
        <small className="muted">{watch.where}</small>
        <p className="lw-actions"><button type="button" onClick={() => void postWatch({ action: "decide", id: watch.id, decision: "active" }).then((result) => done(result.ok))}>{t("盯住")}</button>
          <button type="button" onClick={() => void postWatch({ action: "decide", id: watch.id, decision: "retired" }).then((result) => done(result.ok))}>{t("不要")}</button></p>
      </li>)}</ul></>}
    {less.length > 0 && <><h3>{t("本周的少来调整")}</h3><LessList entries={less} /></>}
    {problem && <small role="alert">{problem}</small>}
  </>;
}
