"use client";

import { useState, type ReactNode } from "react";
import { WANT_OPTIONS, WANTS_PICKS_MAX, WANTS_TEXT_MAX } from "@crossline/core/assess-wants";
import type { WantsRequest } from "../lib/contract";
import { charCount, togglePick, wantsProblem } from "../lib/flow";

/**
 * What the person wants to do: chips they toggle (in the order they pick them, at most six) and one free line. Used as the test's last
 * step — answered while the figure is drawn — and on the result page for someone who skipped it.
 */
export function WantsPicker({ wants, onChange }: { wants: WantsRequest; onChange: (wants: WantsRequest) => void }) {
  const full = wants.picks.length >= WANTS_PICKS_MAX;
  return <div className="as-wants">
    <div className="as-chips" role="group" aria-label="想同时做的事">
      {WANT_OPTIONS.map((option) => {
        const on = wants.picks.includes(option.id);
        return <button key={option.id} type="button" className="as-chip" aria-pressed={on} data-on={on || undefined}
          disabled={!on && full} onClick={() => onChange(togglePick(wants, option.id))}>{option.label}</button>;
      })}
    </div>
    <label className="as-field">
      <span>还有别的？写一句（可选）</span>
      <input type="text" value={wants.text} maxLength={WANTS_TEXT_MAX * 2} placeholder="比如：想把读书笔记做成播客" autoComplete="off"
        onChange={(event) => onChange({ ...wants, text: event.target.value })} aria-describedby="as-wants-count" />
      <small id="as-wants-count" className="as-note">{charCount(wants.text.trim())} / {WANTS_TEXT_MAX}</small>
    </label>
  </div>;
}

/** The test's last step: pick, then see the result; skipping keeps the type's own suggestion. */
export function WantsStep({ wants, busy, error, onChange, onSubmit, onSkip }: {
  wants: WantsRequest; busy: boolean; error: string | null;
  onChange: (wants: WantsRequest) => void; onSubmit: () => void; onSkip: () => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const submit = () => { const found = wantsProblem(wants); setProblem(found); if (!found && !busy) onSubmit(); };
  return <section className="as-sheet">
    <p className="as-kicker">最后三步 · 3 / 3</p>
    <h2>你想同时做哪几件事？</h2>
    <p className="as-note">选两三项最好。我们按 Crossline 的飞轮把它们排成三条主线：一条线的产出，成为下一条线的输入。你的专属形象正在画，选完就能看到结果。</p>
    <WantsPicker wants={wants} onChange={(next) => { onChange(next); if (problem) setProblem(wantsProblem(next)); }} />
    {(problem || error) && <p className="as-error" role="alert">{problem ?? error}</p>}
    <div className="as-nav">
      <button type="button" onClick={onSkip} disabled={busy}>跳过</button>
      <button type="button" className="as-primary" onClick={submit} disabled={busy}>{busy ? "正在组合…" : "看结果"}</button>
    </div>
  </section>;
}

/** On the result page: the same choice, inline, for someone who skipped it or wants to change it. */
export function WantsInline({ initial, left, busy, error, onSubmit, onCancel }: {
  initial: WantsRequest; left: number; busy: boolean; error: string | null; onSubmit: (wants: WantsRequest) => void; onCancel?: (() => void) | undefined;
}): ReactNode {
  const [wants, setWants] = useState<WantsRequest>(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = () => { const found = wantsProblem(wants); setProblem(found); if (!found && !busy) onSubmit(wants); };
  return <div className="as-wants-inline">
    <WantsPicker wants={wants} onChange={(next) => { setWants(next); if (problem) setProblem(wantsProblem(next)); }} />
    {(problem || error) && <p className="as-error" role="alert">{problem ?? error}</p>}
    <div className="as-row">
      <button type="button" className="as-primary" onClick={submit} disabled={busy}>{busy ? "正在组合…" : "按这些组合"}</button>
      {onCancel && <button type="button" onClick={onCancel} disabled={busy}>取消</button>}
    </div>
    <p className="as-note">还能改 {left} 次。</p>
  </div>;
}
