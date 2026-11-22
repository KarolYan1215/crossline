"use client";

import { cardWordsHead, pointLabels, scaleAnswerLine, type ProfileCard } from "@crossline/core";
import { useT } from "../locale-context";
import { VoiceField } from "../ui/voice/voice-input";

/** What the person did on this round's cards: a dot per item (1 to the item's points), and words per card. */
export type CardAnswers = { taps: Record<string, number>; words: Record<string, string> };
export const NO_CARD_ANSWERS: CardAnswers = { taps: {}, words: {} };

/**
 * The cards' part of the reply, in the lines the worker reads back without a model (`readCardAnswers`): one line per tapped item, and the
 * card's box under its head so the extraction knows what the words add to. An item not tapped is skipped, words or not: since 2026-11-22
 * the box is a supplement to the taps, never a stand-in for them. The interview asks no cards since then (the scale is its own page,
 * scale-step.tsx); this stays for a round written before.
 */
export function cardReplyLines(cards: readonly ProfileCard[], answers: CardAnswers): string[] {
  return cards.flatMap((card) => {
    const taps = card.items.filter((item) => answers.taps[item.id]).map((item) => scaleAnswerLine(item, answers.taps[item.id]!));
    const words = (answers.words[card.id] ?? "").trim().replace(/\s*\n+\s*/g, " ");
    return words ? [...taps, `${cardWordsHead(card)}${words}`] : taps;
  });
}

/** Dot sizes from the ends to the middle: the ends say more, so they are larger (docs/profile-and-agent-kit.md §三). */
const dotSize = (score: number, points: number) => { const fromEnd = Math.min(score - 1, points - score); return fromEnd === 0 ? 26 : fromEnd === 1 ? 20 : 16; };

/**
 * The profile module's cards (flow v2): each item a row of dots, one per point, labelled at both ends and in the middle, and one box per
 * card for what the taps do not say. The item texts are shown as written: the answer line must match them word for word.
 */
export function ProfileCards({ cards, answers, disabled, onChange }: {
  cards: readonly ProfileCard[]; answers: CardAnswers; disabled: boolean; onChange: (next: CardAnswers) => void;
}) {
  const t = useT();
  if (!cards.length) return null;
  return <div className="ob-cards" aria-label={t("画像卡片")}>
    {cards.map((card) => <fieldset key={card.id} className="ob-scale-card">
      <legend>{card.title}</legend>
      {card.items.map((item) => {
        const labels = pointLabels(item);
        return <div key={item.id} className="ob-scale-item">
          <p>{item.text}</p>
          <div className="ob-scale-dots" role="radiogroup" aria-label={item.text}>
            {labels.map((label, index) => { const score = index + 1; return <button key={score} type="button" role="radio" disabled={disabled}
              aria-checked={answers.taps[item.id] === score} aria-label={`${score}/${item.points} ${label}`}
              style={{ width: dotSize(score, item.points), height: dotSize(score, item.points) }}
              onClick={() => onChange({ ...answers, taps: { ...answers.taps, [item.id]: answers.taps[item.id] === score ? 0 : score } })} />; })}
          </div>
          <div className="ob-scale-anchors" aria-hidden="true"><span>{item.anchors[0]}</span><span>{item.anchors[1]}</span><span>{item.anchors[2]}</span></div>
        </div>;
      })}
      <VoiceField kind="interview"><textarea rows={1} value={answers.words[card.id] ?? ""} disabled={disabled} aria-label={t("补充（可选）")}
        placeholder={t("点选之外还想说的，可以写在这里；它补充点选，不代替点选")}
        onChange={(event) => onChange({ ...answers, words: { ...answers.words, [card.id]: event.target.value } })} /></VoiceField>
    </fieldset>)}
    <small className="ob-muted">{t("点选最接近的一格，再点一次取消；不想答的卡片可以留空。")}</small>
  </div>;
}
