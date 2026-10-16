"use client";

import { useId, useState, type KeyboardEvent } from "react";
import { ASK_QUADRANTS, ASK_QUADRANT_LABEL, type Ask, type AskQuadrant } from "@crossline/core";
import { AskDeck, DeckNav, useAskList, useDeck } from "./ask-drawer";
import { byQuadrant } from "./model";
import type { AskPreviews } from "./types";
import { useLocale, useT } from "../locale-context";
import { punct } from "../task/format";

/** Arrow keys step through a stack only when focus is not in something that takes them itself. */
const ownsArrows = (target: EventTarget | null) => {
  const element = target as HTMLElement | null;
  return Boolean(element && (/^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName) || element.isContentEditable || element.closest('[role="slider"]')));
};

/**
 * This week's asks on 待确认, in the four Eisenhower quadrants (`askQuadrant`): urgent and important first, in reading order. Each
 * quadrant is a drawer — its top ask open, the next two as edges — stepped through with ‹ › or the arrow keys while focus is inside it,
 * and folded with its heading. A bar on top draws how the week's decisions split between them.
 */
export function AskBoard({ initial, previews }: { initial: Ask[]; previews: AskPreviews }) {
  const { asks, onDone } = useAskList(initial, (ask) => !ask.entersOn);
  const groups = byQuadrant(asks);
  const t = useT();
  return <section className="ak-board" id="asks" aria-label={t("待决事项")}>
    <header className="ak-board-head">
      <h2>{t("待决事项 · {{count}}", { count: asks.length })}</h2>
      {asks.length > 0 && <QuadrantBar groups={groups} />}
    </header>
    {asks.length === 0 ? <p className="muted ak-empty">{t("本周暂无待决事项。")}</p>
      : <div className="ak-quadrants">{ASK_QUADRANTS.map((quadrant) =>
        <Quadrant key={quadrant} quadrant={quadrant} asks={groups[quadrant]} previews={previews} onDone={onDone} />)}</div>}
  </section>;
}

/** One bar split by quadrant, each part a link to its quadrant, the count inside it; hovering gives the exact share. */
export function QuadrantBar({ groups }: { groups: Record<AskQuadrant, Ask[]> }) {
  const t = useT(), locale = useLocale();
  const total = ASK_QUADRANTS.reduce((sum, quadrant) => sum + groups[quadrant].length, 0);
  return <div className="ak-qbar" role="img" aria-label={ASK_QUADRANTS.map((quadrant) => `${t(ASK_QUADRANT_LABEL[quadrant])} ${groups[quadrant].length}`).join(punct(locale, "，"))}>
    {ASK_QUADRANTS.filter((quadrant) => groups[quadrant].length).map((quadrant) => <a key={quadrant} href={`#q-${quadrant}`} data-quadrant={quadrant}
      style={{ flexGrow: groups[quadrant].length }} title={t("{{quadrant}} {{count}} 项 · {{percent}}%", { quadrant: t(ASK_QUADRANT_LABEL[quadrant]), count: groups[quadrant].length, percent: Math.round(groups[quadrant].length / total * 100) })}>
      <span className="mono">{groups[quadrant].length}</span><span className="ak-qbar-label">{t(ASK_QUADRANT_LABEL[quadrant])}</span></a>)}
  </div>;
}

function Quadrant({ quadrant, asks, previews, onDone }: { quadrant: AskQuadrant; asks: Ask[]; previews: AskPreviews; onDone: (id: string) => void }) {
  const { at, go, pick } = useDeck(asks.length);
  const [open, setOpen] = useState(true);
  const body = useId();
  const t = useT();
  const label = t(ASK_QUADRANT_LABEL[quadrant]);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if ((event.key !== "ArrowLeft" && event.key !== "ArrowRight") || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (ownsArrows(event.target)) return;
    event.preventDefault();
    go(event.key === "ArrowRight" ? 1 : -1);
  };
  return <section className="ak-quadrant" id={`q-${quadrant}`} data-quadrant={quadrant} data-empty={!asks.length || undefined} aria-label={label} onKeyDown={onKeyDown}>
    <header>
      <h3><button type="button" className="ak-q-toggle" aria-expanded={asks.length ? open : undefined} aria-controls={asks.length ? body : undefined}
        disabled={!asks.length} onClick={() => setOpen(!open)}>
        <span className="ak-q-mark" aria-hidden="true" />{label}<span className="mono ak-q-count">{asks.length || t("无")}</span>
      </button></h3>
      {open && <DeckNav at={at} count={asks.length} go={go} label={t("切换「{{label}}」", { label })} />}
    </header>
    {asks.length > 0 && <div id={body} hidden={!open}><AskDeck asks={asks} at={at} pick={pick} onDone={onDone} previews={previews} level={4} /></div>}
  </section>;
}
