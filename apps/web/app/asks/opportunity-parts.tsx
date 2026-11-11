"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { AskFormPreview, AskFormTrack, AskTag } from "@crossline/core";
import { LineTag, Tag } from "../ui/tag";
import { useT } from "../locale-context";
import "./opportunity-parts.css";

/**
 * The opportunity agent's parts of a card (docs/opportunity-agent.md §18): its type and the lines it serves with code's relevance, the
 * per-field preview before a sign-up, and the sign-up's progress with its latest screenshot, receipt and calendar step.
 */

export function AskTags({ tags }: { tags: AskTag[] }) {
  const t = useT();
  return <p className="ak-tags" aria-label={t("类型与主线")}>
    {tags.map((tag, index) => tag.kind === "type"
      ? <Tag key={index} tone="info">{tag.label}</Tag>
      : <LineTag key={index} line={tag.line} {...(tag.title ? { title: tag.title } : {})}>
        {tag.label}{tag.score !== undefined && <span className="ak-tag-score" aria-label={t("相关度 {{score}}", { score: tag.score })}> · {tag.score}</span>}
      </LineTag>)}
  </p>;
}

const STATE_MARK: Record<AskFormPreview["rows"][number]["state"], string> = { ready: "✓", held: "●", missing: "!" };

export function FormPreviewView({ preview }: { preview: AskFormPreview }) {
  const t = useT();
  const state: Record<AskFormPreview["rows"][number]["state"], string> = { ready: t("已备好"), held: t("已加密保存"), missing: t("缺") };
  return <section className="ak-form-preview" aria-label={t("代填预览")}>
    <p className="ak-fp-head"><b>{t("代填预计会用")}</b><small>{t("资料包 v{{version}}", { version: preview.kitVersion })}</small></p>
    <ul>
      {preview.rows.map((row) => <li key={row.key} data-state={row.state}>
        <span className="ak-fp-mark" aria-hidden="true">{STATE_MARK[row.state]}</span>
        <span className="ak-fp-label">{row.label}<small>{row.source}</small></span>
        <span className="ak-fp-value">{row.value ?? state[row.state]}</span>
      </li>)}
    </ul>
  </section>;
}

/** Refreshes the page every few seconds while the run is moving by itself, so the steps and the screenshot follow it. */
export function FormTrackView({ track }: { track: AskFormTrack }) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!track.live) return;
    const timer = window.setInterval(() => router.refresh(), 8_000);
    return () => window.clearInterval(timer);
  }, [track.live, router]);
  const label: Record<AskFormTrack["steps"][number]["state"], string> = { done: t("已完成"), now: t("进行中"), todo: t("未到"), stuck: t("等本人") };
  return <section className="ak-form-track" aria-label={t("代填进度")}>
    <ol className="ak-ft-steps">
      {track.steps.map((step) => <li key={step.id} data-state={step.state} title={label[step.state]}>
        <span className="ak-ft-dot" aria-hidden="true" /><span>{step.label}</span><span className="sr-only">{label[step.state]}</span>
      </li>)}
    </ol>
    {track.detail.length > 0 && <ul className="ak-ft-detail">{track.detail.map((line, index) => <li key={index}>{line}</li>)}</ul>}
    {track.shot && <div className="ak-ft-shot">
      <button type="button" className="ak-ft-shot-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? t("收起截图") : track.shot.label}{track.live && <small> · {t("每 8 秒刷新")}</small>}
      </button>
      {open && <a href={track.shot.href} target="_blank" rel="noreferrer"><img src={track.shot.href} alt={track.shot.label} loading="lazy" /></a>}
    </div>}
  </section>;
}
