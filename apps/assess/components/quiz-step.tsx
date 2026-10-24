"use client";

import { useEffect, useRef } from "react";
import { PAIR_SCALE, QUIZ_ITEMS } from "@crossline/core/assess";
import { QUIZ_LENGTH, answeredCount, type Flow } from "../lib/flow";

/** The circles' sizes, outside in (decided 2026-10-24, the MBTI test's layout): the clearer the answer, the bigger the circle. */
const CIRCLE = [44, 34, 24, 34, 44];

/**
 * One situation per screen with two options A and B, answered on five circles from 「明显更像 A」 to 「明显更像 B」 — big at both ends,
 * smaller towards the middle — as a native radio group (the browser gives arrow keys and screen-reader semantics for free). A click, a tap
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
    <p className="as-kicker"><span className="as-num">{flow.index + 1}</span> / {QUIZ_LENGTH} · {item.scene}</p>
    <fieldset className="as-likert" onKeyDown={(event) => { if (event.key.startsWith("Arrow")) arrow.current = true; }}>
      <legend><h2 ref={heading} tabIndex={-1} className="as-statement">{item.text}</h2></legend>
      <dl className="as-pair">
        <div className="as-pair-a"><dt>A</dt><dd>{item.a}</dd></div>
        <div className="as-pair-b"><dt>B</dt><dd>{item.b}</dd></div>
      </dl>
      <div className="as-scale">
        <span className="as-scale-end as-scale-a" aria-hidden="true">更像<br />A</span>
        {PAIR_SCALE.map((label, offset) => {
          const value = offset + 1;
          return <label key={value} className="as-circle" data-side={value < 3 ? "a" : value > 3 ? "b" : "mid"} data-on={chosen === value || undefined}
            style={{ ["--size" as string]: `${CIRCLE[offset]}px` }}>
            <input type="radio" name={item.id} value={value} checked={chosen === value} aria-label={label}
              onChange={() => { const advance = !arrow.current; arrow.current = false; onChoose(value, advance); }}
              onClick={() => { if (chosen === value && !arrow.current) onChoose(value, true); }} />
            <i aria-hidden="true" />
          </label>;
        })}
        <span className="as-scale-end as-scale-b" aria-hidden="true">更像<br />B</span>
      </div>
    </fieldset>
    <div className="as-nav">
      <button type="button" onClick={onBack}>{flow.index === 0 ? "返回" : "上一题"}</button>
      {chosen !== undefined && <button type="button" onClick={onNext}>{flow.index === QUIZ_LENGTH - 1 ? "下一步" : "下一题"}</button>}
    </div>
    <p className="as-note as-only-mouse">键盘：按 1–5 作答，Enter 下一题</p>
  </section>;
}
