"use client";

import { useState } from "react";
import { MILESTONE_RISK_KIND_LABEL, riskLevelOf, type AskItem } from "@crossline/core";
import { RiskGlyph } from "../milestones/risk-glyph";
import { ASK_ITEMS_SHOWN, itemsShown, shortDay } from "./model";
import { useLocale, useT } from "../locale-context";

/**
 * A folded card's rows as a list to scan: each milestone's name (a link), its deadline, its level drawn as the 主线 page's three bars,
 * and its kinds as tags. Five rows are shown; the rest open with 「另有 N 个」. The full name is in the hover title when the row cuts it.
 */
export function AskItems({ items }: { items: AskItem[] }) {
  const [expanded, setExpanded] = useState(false);
  const t = useT(), locale = useLocale();
  const { shown, more } = itemsShown(items, expanded);
  if (!items.length) return null;
  return <div className="ak-items">
    <ul className="ak-item-list">{shown.map((item) => {
      const level = riskLevelOf(item.risks ?? []);
      const kinds = [...new Set((item.risks ?? []).map((risk) => MILESTONE_RISK_KIND_LABEL[risk.kind]))];
      return <li key={item.id} data-line={item.line} data-level={level ?? undefined}>
        {item.href ? <a className="ak-item-name" href={item.href} title={item.title}>{item.title}</a>
          : <span className="ak-item-name" title={item.title}>{item.title}</span>}
        <span className="ak-item-due mono">{item.dueDay ? t("截止 {{day}}", { day: shortDay(item.dueDay, locale) }) : t("未定日期")}</span>
        <span className="ak-item-risk"><RiskGlyph level={level} size={14} />{kinds.map((kind) => <span key={kind} className="risk-kind">{t(kind)}</span>)}</span>
      </li>;
    })}</ul>
    {items.length > ASK_ITEMS_SHOWN && <button type="button" className="text-button ak-items-more" aria-expanded={expanded}
      onClick={() => setExpanded(!expanded)}>{expanded ? t("只看前 {{count}} 个", { count: ASK_ITEMS_SHOWN }) : t("另有 {{count}} 个", { count: more })}</button>}
  </div>;
}
