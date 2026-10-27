"use client";

import { useState } from "react";
import { useT } from "../locale-context";
import type { DateBatch } from "./onboarding-types";

const CONFIDENCE: Record<string, string> = { high: "把握高", medium: "需留意", low: "不确定" };

/**
 * Dates found in the person's files, as one card. Every row shows what the file actually said, so the person
 * judges the source and not the model. Rows the reader was unsure about start unchecked; nothing reaches the
 * calendar until the person confirms.
 */
export function DateBatchCard({ batch, onDecide, onRedo, busy }: {
  batch: DateBatch; busy: boolean; onDecide: (batchId: string, includedIds: string[]) => void; onRedo: () => void;
}) {
  const t = useT();
  const [checked, setChecked] = useState<Record<string, boolean>>(() => Object.fromEntries(batch.items.map((item) => [item.id, item.checked])));
  const [open, setOpen] = useState<string | undefined>();
  const chosen = batch.items.filter((item) => checked[item.id]);
  const blocks = chosen.reduce((sum, item) => sum + item.blocks, 0);
  return <section className="ob-dates" aria-label={t("从文件识别到的日期")}>
    <header>
      <b>{batch.documentCount ? t("从 {{files}}识别到 {{count}} 项", { files: t("{{count}} 个文件", { count: batch.documentCount }), count: batch.items.length }) : t("从回答中识别到 {{count}} 项", { count: batch.items.length })}</b>
      <span className="ob-muted">{t("勾选的日期加入日历与画像；不确定的默认不勾选。")}</span>
    </header>
    <ul>
      {batch.items.map((item) => <li key={item.id} data-confidence={item.confidence}>
        <label>
          <input type="checkbox" checked={Boolean(checked[item.id])} onChange={(event) => setChecked((previous) => ({ ...previous, [item.id]: event.target.checked }))} />
          <span className="ob-date-title">{item.title}</span>
          <span className="ob-date-when">{item.when}</span>
          <span className="ob-tag" data-kind={item.confidence === "low" ? "unsupported" : item.confidence === "medium" ? "pending" : "done"}>{t(CONFIDENCE[item.confidence] ?? "")}</span>
        </label>
        <button type="button" className="ob-text ob-quote-toggle" aria-expanded={open === item.id} onClick={() => setOpen(open === item.id ? undefined : item.id)}>{t("原文")}</button>
        {open === item.id && <blockquote>{item.quote}{item.note && <small>{item.note}</small>}</blockquote>}
      </li>)}
    </ul>
    {batch.dropped.length > 0 && <details className="ob-dates-dropped">
      <summary className="ob-muted">{t("另有 {{count}} 项在原文里找不到写着这一天的句子，没有写入", { count: batch.dropped.length })}</summary>
      <ul>{batch.dropped.map((title, index) => <li key={`${index}:${title}`}>{title}</li>)}</ul>
      <small className="ob-muted">{t("需要的话，在回答里写出日期即可补上。")}</small>
    </details>}
    {batch.questions.length > 0 && <div className="ob-date-questions"><b>{t("待确认：")}</b><ul>{batch.questions.map((question) => <li key={question}>{question}</li>)}</ul></div>}
    <footer>
      <button type="button" className="ob-btn" disabled={busy || chosen.length === 0}
        onClick={() => onDecide(batch.id, chosen.map((item) => item.id))}>{blocks ? t("加入日历（{{count}} 项，{{blocks}}）", { count: chosen.length, blocks: t("{{count}} 个时间块", { count: blocks }) }) : t("加入日历（{{count}} 项）", { count: chosen.length })}</button>
      <button type="button" className="ob-btn ob-quiet" disabled={busy} onClick={() => onDecide(batch.id, [])}>{t("都不加入")}</button>
      <button type="button" className="ob-btn ob-quiet" disabled={busy} onClick={onRedo}>{t("重新识别")}</button>
    </footer>
  </section>;
}
