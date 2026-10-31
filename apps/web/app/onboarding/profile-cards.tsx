"use client";

import { cardWordsHead, scaleAnswerLine, type ProfileCard } from "@crossline/core";
import { useT } from "../locale-context";

/** What the person did on this round's cards: a dot per item (1–5), and words per card. */
export type CardAnswers = { taps: Record<string, number>; words: Record<string, string> };
export const NO_CARD_ANSWERS: CardAnswers = { taps: {}, words: {} };

/**
 * The cards' part of the reply, in the lines the worker reads back without a model (`readCardAnswers`): one line per tapped item, and the
 * card's box under its head so the extraction knows what the words answer. A card left alone sends nothing and counts as skipped.
 */
export function cardReplyLines(cards: readonly ProfileCard[], answers: CardAnswers): string[] {
  return cards.flatMap((card) => {
    const taps = card.items.filter((item) => answers.taps[item.id]).map((item) => scaleAnswerLine(item, answers.taps[item.id]!));
    const words = (answers.words[card.id] ?? "").trim().replace(/\s*\n+\s*/g, " ");
    return words ? [...taps, `${cardWordsHead(card)}${words}`] : taps;
  });
}

/** Dot sizes from the ends to the middle: the ends say more, so they are larger (docs/profile-and-agent-kit.md §三). */
const DOT_SIZE = [26, 20, 16, 20, 26];

/**
 * The profile module's cards (flow v2): each item a row of five dots labelled at both ends and in the middle only, and one box per card
 * for anyone who would rather say it in a sentence. The item texts are shown as written: the answer line must match them word for word.
 */
export function ProfileCards({ cards, answers, disabled, onChange }: {
  cards: readonly ProfileCard[]; answers: CardAnswers; disabled: boolean; onChange: (next: CardAnswers) => void;
}) {
  const t = useT();
  if (!cards.length) return null;
  return <div className="ob-cards" aria-label={t("画像卡片")}>
    {cards.map((card) => <fieldset key={card.id} className="ob-scale-card">
      <legend>{card.title}</legend>
      {card.items.map((item) => <div key={item.id} className="ob-scale-item">
        <p>{item.text}</p>
        <div className="ob-scale-dots" role="radiogroup" aria-label={item.text}>
          {[1, 2, 3, 4, 5].map((score) => <button key={score} type="button" role="radio" disabled={disabled}
            aria-checked={answers.taps[item.id] === score} aria-label={`${score}/5${score === 1 ? ` ${item.anchors[0]}` : score === 3 ? ` ${item.anchors[1]}` : score === 5 ? ` ${item.anchors[2]}` : ""}`}
            style={{ width: DOT_SIZE[score - 1], height: DOT_SIZE[score - 1] }}
            onClick={() => onChange({ ...answers, taps: { ...answers.taps, [item.id]: answers.taps[item.id] === score ? 0 : score } })} />)}
        </div>
        <div className="ob-scale-anchors" aria-hidden="true"><span>{item.anchors[0]}</span><span>{item.anchors[1]}</span><span>{item.anchors[2]}</span></div>
      </div>)}
      <textarea rows={1} value={answers.words[card.id] ?? ""} disabled={disabled} aria-label={t("用一句话代替点选（可选）")}
        placeholder={t("不想点选，也可以用一句话说说")}
        onChange={(event) => onChange({ ...answers, words: { ...answers.words, [card.id]: event.target.value } })} />
    </fieldset>)}
    <small className="ob-muted">{t("点选最接近的一格，再点一次取消；不想答的卡片可以留空。")}</small>
  </div>;
}
