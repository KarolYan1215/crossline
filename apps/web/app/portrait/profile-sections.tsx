"use client";

import { useEffect, useState } from "react";
import type { ClaimBasis, ClaimKind, PrivacyLevel, ReportSectionView } from "@crossline/core";
import { SegmentedControl } from "../ui/controls";
import { Tag } from "../ui/tag";
import { useT } from "../locale-context";

type Item = { id: string; instrument: string; text: string; anchors: readonly [string, string, string];
  answer: { by: "tapped" | "mapped" | "skipped" | "pending"; score?: number } | null };
type Report = { sections: ReportSectionView[]; items: Item[] };

const KIND: Record<ClaimKind, string> = { self_reported: "自述", inferred: "推断", measured: "测量", observed: "观察" };
const LEVELS: ReadonlyArray<{ value: PrivacyLevel; label: string; title: string }> = [
  { value: "public", label: "公开", title: "可出现在分享图上" },
  { value: "agent", label: "给 agent", title: "随导出包交给本人使用的 AI 工具" },
  { value: "private", label: "仅自己", title: "只在本页显示" }
];
const BY: Record<NonNullable<Item["answer"]>["by"], string> = { tapped: "点选", mapped: "由文字折算", skipped: "跳过", pending: "待读取" };

/** What a claim rests on, in one line: the person's own words, the card items behind it, or a behaviour and its window. */
function basisLine(basis: ClaimBasis, t: ReturnType<typeof useT>): string {
  if ("quote" in basis) return t("原话：「{{quote}}」", { quote: basis.quote });
  if ("instrument" in basis) return t("依据：{{count}} 道卡片题", { count: basis.items.length });
  return t("依据：{{behaviour}}（{{window}}）", { behaviour: basis.behaviour, window: basis.window });
}

/**
 * The report by section (docs/profile-and-agent-kit.md §五–§七): every claim with what it rests on and how sure it is, 符合/不符合 per claim,
 * who may see each section, and the card answers behind the measured ones, each answerable again by a tap.
 */
export function ProfileSections() {
  const t = useT();
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void fetch("/api/profile/report", { cache: "no-store" }).then((response) => response.json()).then((body: Report) => setReport(body)).catch(() => setReport(null));
  }, []);
  const change = async (body: Record<string, unknown>) => {
    setBusy(true); setError("");
    const response = await fetch("/api/profile/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const next = await response?.json().catch(() => null) as (Report & { ok?: boolean }) | null;
    if (response?.ok && next) setReport(next); else setError(t("未能保存，请重试"));
    setBusy(false);
  };
  if (!report) return null;
  const sections = report.sections.filter((section) => section.claims.length > 0);
  if (!sections.length && !report.items.length) return null;
  return <section className="pt-page pt-claims" data-private="" data-no-export="" id="pt-s-claims">
    <h2><small>04</small>{t("逐条核对")}</h2>
    <p className="pt-lead">{t("每一条都标明来源：自述是本人说的，推断是从本人的话里读出的，测量来自卡片点选。不符合的条目会留在这里，但不再导出，下次也不再写入。")}</p>
    {error && <p role="alert" className="pt-claims-error">{error}</p>}
    {sections.map((section) => <article key={section.section} className="pt-claims-section">
      <header>
        <h3>{t(section.label)}</h3>
        <SegmentedControl label={t("「{{section}}」谁能看到", { section: t(section.label) })} value={section.privacy} disabled={busy}
          options={LEVELS.map((level) => ({ value: level.value, label: t(level.label), title: t(level.title) }))}
          onChange={(level) => void change({ action: "privacy", section: section.section, level })} />
      </header>
      <ul>{section.claims.map((claim) => <li key={claim.id} data-status={claim.personStatus}>
        <p className={claim.kind === "measured" || claim.basis.some((basis) => "instrument" in basis) ? "" : "gen"}>{claim.statement}</p>
        <div className="pt-claim-meta">
          <Tag tone={claim.kind === "measured" ? "info" : "neutral"}>{t(KIND[claim.kind])}</Tag>
          <small>{t("把握 {{percent}}%", { percent: Math.round(claim.confidence * 100) })}</small>
          {claim.basis.slice(0, 1).map((basis, index) => <small key={index} className="pt-claim-basis">{basisLine(basis, t)}</small>)}
          <span className="pt-claim-judge">
            <button type="button" aria-pressed={claim.personStatus === "confirmed"} disabled={busy}
              onClick={() => void change({ action: "judge", claimId: claim.id, status: claim.personStatus === "confirmed" ? null : "confirmed" })}>{t("符合")}</button>
            <button type="button" aria-pressed={claim.personStatus === "rejected"} disabled={busy}
              onClick={() => void change({ action: "judge", claimId: claim.id, status: claim.personStatus === "rejected" ? null : "rejected" })}>{t("不符合")}</button>
          </span>
        </div>
      </li>)}</ul>
    </article>)}
    {report.items.length > 0 && <details className="advanced pt-claims-items">
      <summary>{t("卡片作答（{{count}} 题）", { count: report.items.length })}</summary>
      <p className="ob-muted">{t("由文字折算的题，点选一格即改为本人点选；「跳过」后这道题不计分。")}</p>
      <ol>{report.items.map((item) => <li key={item.id}>
        <p>{item.text}</p>
        <small>{item.answer ? item.answer.score ? t("{{by}} {{score}}/5", { by: t(BY[item.answer.by]), score: item.answer.score }) : t(BY[item.answer.by]) : ""}
          {" · "}{item.anchors[0]} → {item.anchors[2]}</small>
        <span className="pt-claim-scale" role="radiogroup" aria-label={item.text}>
          {[1, 2, 3, 4, 5].map((score) => <button key={score} type="button" role="radio" disabled={busy}
            aria-checked={item.answer?.by === "tapped" && item.answer.score === score}
            onClick={() => void change({ action: "item", itemId: item.id, score })}>{score}</button>)}
          <button type="button" disabled={busy || item.answer?.by === "skipped"} onClick={() => void change({ action: "item", itemId: item.id, score: null })}>{t("跳过")}</button>
        </span>
      </li>)}</ol>
    </details>}
  </section>;
}
