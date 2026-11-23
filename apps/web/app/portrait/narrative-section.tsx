"use client";

import { useState } from "react";
import { useLocale, useT } from "../locale-context";

export type NarrativeView = {
  at: string;
  sections: Array<{ key: string; heading: string; paragraphs: string[]; level: 1 | 2 | 3; ratable: boolean; ratableAt: string | null;
    rating: { verdict: "fits" | "partial" | "off"; note?: string; at: string } | null }>;
};

const VERDICTS = [["fits", "准"], ["partial", "部分对"], ["off", "不准"]] as const;

/**
 * The narrative written before the report (docs/plans/portrait-depth-1122.md §三–§四): the life story, one section per insight, the
 * principle that joins them. No quotes, scores or sources. The readings farthest from the person's own account come last and are rated
 * only after a few days, once the whole has been read; 不准 keeps a section out of the next portrait.
 */
export function NarrativeSection({ narrative, onChange }: { narrative: NarrativeView; onChange: (next: NarrativeView) => void }) {
  const t = useT();
  const locale = useLocale();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const rate = async (key: string, verdict: string) => {
    setBusy(key); setError("");
    const response = await fetch("/api/portrait/narrative", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, verdict }) }).catch(() => null);
    const body = await response?.json().catch(() => null) as { ok?: boolean; narrative?: NarrativeView } | null;
    if (response?.ok && body?.narrative) onChange(body.narrative); else setError(t("未能保存，请重试"));
    setBusy("");
  };
  const firstFar = narrative.sections.findIndex((section) => section.level === 3);
  return <section className="pt-page pt-narrative" data-private="" id="pt-s-narrative">
    <h2>{t("人生叙事与洞察")}</h2>
    {error && <p role="alert" className="pt-claims-error">{error}</p>}
    {narrative.sections.map((section, index) => <article key={section.key} className="pt-narrative-section" data-level={section.level}>
      {index === firstFar && <p className="pt-narrative-far muted">{t("下面几节离本人自己的说法更远一些。先读完整份，过几天再评。")}</p>}
      <h3 className="pt-serif">{section.heading}</h3>
      {section.paragraphs.map((paragraph, at) => <p key={at} className="gen">{paragraph}</p>)}
      <div className="pt-narrative-rate" data-no-export="">
        {section.ratable ? VERDICTS.map(([verdict, label]) => <button key={verdict} type="button" className="secondary-button" disabled={busy === section.key}
          aria-pressed={section.rating?.verdict === verdict} onClick={() => void rate(section.key, verdict)}>{t(label)}</button>)
          : <small className="muted">{t("{{date}} 起可以评", { date: new Date(section.ratableAt ?? narrative.at).toLocaleDateString(locale === "en" ? "en-US" : "zh-CN", { month: "numeric", day: "numeric" }) })}</small>}
      </div>
    </article>)}
  </section>;
}
