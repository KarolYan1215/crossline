"use client";

import { PART_LABEL, PERSONAL_DIMENSION_IDS, POINT_SECTIONS, personalDimensionLabel, type ProfilePoint } from "@crossline/core";
import { useT } from "../locale-context";

const SOURCE_LABEL: Record<ProfilePoint["source"], string> = { stated: "原话", confirmed: "本人确认", corrected: "本人更正" };

/**
 * The live portrait beside the interview (the points rules, 2026-11-12; by dimension since 2026-11-22, D13): what is settled about the
 * person, grouped by the 24 dimensions the organizing lane files it under (a note it has not filed yet stays under its part) — what they
 * said, the inferences they confirmed, their corrections marked 【自报】 — each with what it rests on, folded. No counts, no confidence,
 * no time left: it fills in as the interview goes.
 */
export function PointsList({ points }: { points: ProfilePoint[] }) {
  const t = useT();
  const standing = points.filter((point) => !point.retracted);
  if (!standing.length) return <p className="ob-muted ob-points-empty">{t("要点会在你回答后列在这里，每条都附原话。")}</p>;
  const groups: Array<{ key: string; label: string; own: ProfilePoint[] }> = [
    ...PERSONAL_DIMENSION_IDS.map((id) => ({ key: id, label: personalDimensionLabel(id) ?? id, own: standing.filter((point) => point.dimension === id) })),
    ...POINT_SECTIONS.map((section) => ({ key: section, label: PART_LABEL[section], own: standing.filter((point) => !personalDimensionLabel(point.dimension) && point.section === section) }))
  ];
  return <section className="ob-points" aria-label={t("要点")}>
    {groups.map(({ key, label, own }) => own.length ? <div key={key} className="ob-points-part">
      <b>{t(label)}</b>
      <ul>{own.map((point) => <li key={point.id} data-source={point.source}>
        <p><small className="ob-points-source">{t(SOURCE_LABEL[point.source])}</small>{point.selfReported && <small className="ob-points-self">{t("【自报】")}</small>} <span className="gen">{point.text}</span></p>
        {(point.quotes.length > 0 || point.external.length > 0 || (point.literature?.length ?? 0) > 0) && <details>
          <summary>{t("依据")}</summary>
          <ul>
            {point.quotes.map((quote) => <li key={`${quote.ref}:${quote.text}`} className="gen">「{quote.text}」</li>)}
            {point.external.map((item) => <li key={item.url}><a href={item.url} target="_blank" rel="noreferrer noopener" className="gen">{item.text || item.url}</a></li>)}
            {(point.literature ?? []).map((item) => <li key={item} className="gen">{item}</li>)}
          </ul>
        </details>}
      </li>)}</ul>
    </div> : null)}
  </section>;
}
