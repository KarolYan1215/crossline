"use client";

import { useEffect, useRef } from "react";
import { LIKERT, QUIZ_ITEMS } from "@crossline/core/assess";
import { QUIZ_LENGTH, answeredCount, type Flow } from "../lib/flow";
import { useT } from "./locale-context";

/**
 * One statement per screen as a native radio group (the browser gives arrow keys and screen-reader semantics for free). A click, a tap
 * or Space answers and moves on; an arrow key only moves the choice, so walking the options never skips a statement. 1–5 and Enter are
 * handled by the parent for the whole page.
 */
export function QuizStep({ flow, onChoose, onBack, onNext }: {
  flow: Flow;
  onChoose: (value: number, advance: boolean) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const item = QUIZ_ITEMS[flow.index]!;
  const chosen = flow.answers[item.id];
  const answered = answeredCount(flow);
  const t = useT();
  const heading = useRef<HTMLHeadingElement>(null);
  const arrow = useRef(false);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [flow.index]);

  return <section className="as-sheet as-quiz">
    <div className="as-progress" role="progressbar" aria-label={t("答题进度")} aria-valuemin={0} aria-valuemax={QUIZ_LENGTH} aria-valuenow={answered}
      aria-valuetext={t("已答 {{answered}} 题，共 {{total}} 题", { answered, total: QUIZ_LENGTH })}>
      <i style={{ width: `${(answered / QUIZ_LENGTH) * 100}%` }} />
    </div>
    <p className="as-kicker"><span className="as-num">{flow.index + 1}</span> / {QUIZ_LENGTH}</p>
    <fieldset className="as-likert" onKeyDown={(event) => { if (event.key.startsWith("Arrow")) arrow.current = true; }}>
      <legend><h2 ref={heading} tabIndex={-1} className="as-statement">{t(item.text)}</h2></legend>
      {LIKERT.map((label, offset) => {
        const value = offset + 1;
        return <label key={value} className="as-option" data-on={chosen === value || undefined}>
          <input type="radio" name={item.id} value={value} checked={chosen === value}
            onChange={() => { const advance = !arrow.current; arrow.current = false; onChoose(value, advance); }}
            onClick={() => { if (chosen === value && !arrow.current) onChoose(value, true); }} />
          <span className="as-option-key" aria-hidden="true">{value}</span>
          <span>{t(label)}</span>
        </label>;
      })}
    </fieldset>
    <div className="as-nav">
      <button type="button" onClick={onBack}>{flow.index === 0 ? t("返回") : t("上一题")}</button>
      {chosen !== undefined && <button type="button" onClick={onNext}>{flow.index === QUIZ_LENGTH - 1 ? t("下一步") : t("下一题")}</button>}
    </div>
    <p className="as-note as-only-mouse">{t("键盘：按 1–5 作答，Enter 下一题")}</p>
  </section>;
}
