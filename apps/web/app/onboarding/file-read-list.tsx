"use client";

import { useState } from "react";
import { joinList } from "../../lib/i18n";
import { useLocale, useT } from "../locale-context";
import type { OnboardingState } from "./onboarding-types";

const SHOWN = 6;

/**
 * What was read from the files, already taken (2026-10-19: what the files say is adopted, not asked): every date and weekly class on the
 * calendar and in the profile, each with the sentence it came from and 移除; items the reader was unsure of are listed apart with 加入.
 */
export function FileReadList({ data, open, onChanged }: { data: NonNullable<OnboardingState["adoptedDates"]>; open: boolean; onChanged: () => void }) {
  const t = useT();
  const locale = useLocale();
  const [busy, setBusy] = useState("");
  const [all, setAll] = useState(false);
  const [quote, setQuote] = useState("");
  const adopted = data.items.filter((item) => item.adopted), left = data.items.filter((item) => !item.adopted);
  if (!data.items.length) return null;
  const change = async (batchId: string, itemId: string, include: boolean) => {
    setBusy(itemId);
    await fetch("/api/onboarding/dates/item", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ batchId, itemId, include }) }).catch(() => undefined);
    setBusy("");
    onChanged();
  };
  const row = (item: (typeof data.items)[number]) => <li key={`${item.batchId}:${item.id}`} data-adopted={item.adopted || undefined}>
    <span className="ob-date-title">{item.title}</span>
    <span className="ob-date-when">{item.when}</span>
    <button type="button" className="ob-text ob-quote-toggle" aria-expanded={quote === item.id} onClick={() => setQuote(quote === item.id ? "" : item.id)}>{t("原文")}</button>
    <button type="button" className="ob-text" disabled={busy !== ""} onClick={() => void change(item.batchId, item.id, !item.adopted)}>{item.adopted ? t("移除") : t("加入")}</button>
    {quote === item.id && <blockquote>{item.quote}{item.note && <small>{item.note}</small>}</blockquote>}
  </li>;
  return <details className="ob-dates ob-file-list" open={open} aria-label={t("文件读出的清单")}>
    <summary><b>{t("从文件读出 {{count}} 项，已加入日历和画像", { count: adopted.length })}</b>{left.length > 0 && <span className="ob-muted">{t("，另有 {{count}} 项不确定", { count: left.length })}</span>}</summary>
    <ul>{(all ? adopted : adopted.slice(0, SHOWN)).map(row)}</ul>
    {adopted.length > SHOWN && !all && <button type="button" className="ob-text" onClick={() => setAll(true)}>{t("展开全部 {{count}} 项", { count: adopted.length })}</button>}
    {left.length > 0 && <><p className="ob-muted">{t("读到了，但不确定，没有加入：")}</p><ul>{left.map(row)}</ul></>}
    {data.dropped.length > 0 && <p className="ob-muted">{t("另有 {{count}} 项在原文里找不到写着这一天的句子，没有写入：{{titles}}。需要的话在回答里写出日期即可。", { count: data.dropped.length, titles: joinList(locale, data.dropped.slice(0, 5)) })}</p>}
  </details>;
}
