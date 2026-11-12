"use client";

import { PART_LABEL, POINT_SECTIONS, type ProfilePoint } from "@crossline/core";
import { useT } from "../locale-context";

const SOURCE_LABEL: Record<ProfilePoint["source"], string> = { stated: "原话", confirmed: "本人确认", corrected: "本人更正" };

/**
 * The points ledger beside the interview (the points rules, 2026-11-12): what is settled about the person, by part — what they said, the
 * inferences they confirmed on a card, and their corrections — each with what it rests on, folded. No prose summary until a part is over.
 */
export function PointsList({ points }: { points: ProfilePoint[] }) {
  const t = useT();
  const standing = points.filter((point) => !point.retracted);
  if (!standing.length) return <p className="ob-muted ob-points-empty">{t("要点会在你回答后列在这里，每条都附原话。")}</p>;
  return <section className="ob-points" aria-label={t("要点")}>
    {POINT_SECTIONS.map((section) => {
      const own = standing.filter((point) => point.section === section);
      return own.length ? <div key={section} className="ob-points-part">
        <b>{t(PART_LABEL[section])}</b>
        <ul>{own.map((point) => <li key={point.id} data-source={point.source}>
          <p><small className="ob-points-source">{t(SOURCE_LABEL[point.source])}</small> <span className="gen">{point.text}</span></p>
          {(point.quotes.length > 0 || point.external.length > 0) && <details>
            <summary>{t("依据 {{count}} 条", { count: point.quotes.length + point.external.length })}</summary>
            <ul>
              {point.quotes.map((quote) => <li key={`${quote.ref}:${quote.text}`} className="gen">「{quote.text}」</li>)}
              {point.external.map((item) => <li key={item.url}><a href={item.url} target="_blank" rel="noreferrer noopener" className="gen">{item.text || item.url}</a></li>)}
            </ul>
          </details>}
        </li>)}</ul>
      </div> : null;
    })}
  </section>;
}
