"use client";

import { useEffect, useRef } from "react";
import { LIKERT, PAIR_SCALE, QUIZ_ITEMS } from "@crossline/core/assess";
import { QUIZ_LENGTH, answeredCount, type Flow } from "../lib/flow";

/**
 * One question per screen — a statement answered on agreement, or a situation with two options A and B answered on which it is closer to — as a native radio group (the browser gives arrow keys and screen-reader semantics for free). A click, a tap
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
  const heading = useRef<HTMLHeadingElement>(null);
  const arrow = useRef(false);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [flow.index]);

  return <section className="as-sheet as-quiz">
    <div className="as-progress" role="progressbar" aria-label="答题进度" aria-valuemin={0} aria-valuemax={QUIZ_LENGTH} aria-valuenow={answered}
      aria-valuetext={`已答 ${answered} 题，共 ${QUIZ_LENGTH} 题`}>
      <i style={{ width: `${(answered / QUIZ_LENGTH) * 100}%` }} />
    </div>
    <p className="as-kicker"><span className="as-num">{flow.index + 1}</span> / {QUIZ_LENGTH}</p>
    <fieldset className="as-likert" onKeyDown={(event) => { if (event.key.startsWith("Arrow")) arrow.current = true; }}>
      <legend><h2 ref={heading} tabIndex={-1} className="as-statement">{item.text}</h2></legend>
      {item.kind === "pair" && <dl className="as-pair">
        <div><dt>A</dt><dd>{item.a}</dd></div>
        <div><dt>B</dt><dd>{item.b}</dd></div>
      </dl>}
      {(item.kind === "pair" ? PAIR_SCALE : LIKERT).map((label, offset) => {
        const value = offset + 1;
        return <label key={value} className="as-option" data-on={chosen === value || undefined}>
          <input type="radio" name={item.id} value={value} checked={chosen === value}
            onChange={() => { const advance = !arrow.current; arrow.current = false; onChoose(value, advance); }}
            onClick={() => { if (chosen === value && !arrow.current) onChoose(value, true); }} />
          <span className="as-option-key" aria-hidden="true">{value}</span>
          <span>{label}</span>
        </label>;
      })}
    </fieldset>
    <div className="as-nav">
      <button type="button" onClick={onBack}>{flow.index === 0 ? "返回" : "上一题"}</button>
      {chosen !== undefined && <button type="button" onClick={onNext}>{flow.index === QUIZ_LENGTH - 1 ? "下一步" : "下一题"}</button>}
    </div>
    <p className="as-note as-only-mouse">键盘：按 1–5 作答，Enter 下一题</p>
  </section>;
}
