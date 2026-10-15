"use client";

import { useState } from "react";
import { APPEARANCE_LABELS, NOTE_MAX, type Appearance } from "../lib/contract";
import { appearanceProblem, charCount, type AppearanceDraft } from "../lib/flow";

type Choice = { value: string; label: string };
const GLASSES: Choice[] = [{ value: "yes", label: "戴眼镜" }, { value: "no", label: "不戴" }];
const entries = (labels: Record<string, string>): Choice[] => Object.entries(labels).map(([value, label]) => ({ value, label }));

/** A row of choices that reads as one control: a native radio group whose labels are the segments. */
function Segments({ name, legend, choices, value, onChange }: {
  name: string; legend: string; choices: Choice[]; value: string | undefined; onChange: (value: string) => void;
}) {
  return <fieldset className="as-segments">
    <legend>{legend}</legend>
    <div>{choices.map((choice) => <label key={choice.value} data-on={value === choice.value || undefined}>
      <input type="radio" name={name} value={choice.value} checked={value === choice.value} onChange={() => onChange(choice.value)} />
      <span>{choice.label}</span>
    </label>)}</div>
  </fieldset>;
}

/** Five choices and an optional line, used only to draw the person's figure from the type's template. */
export function AppearanceStep({ draft, onChange, onBack, onNext }: {
  draft: AppearanceDraft;
  onChange: (draft: AppearanceDraft) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const set = (patch: Partial<AppearanceDraft>) => { const updated = { ...draft, ...patch }; onChange(updated); if (problem) setProblem(appearanceProblem(updated)); };
  const submit = () => { const found = appearanceProblem(draft); setProblem(found); if (!found) onNext(); };
  const glasses = draft.glasses === undefined ? undefined : draft.glasses ? "yes" : "no";

  return <section className="as-sheet">
    <p className="as-kicker">最后两步 · 1 / 2</p>
    <h2>你大概长什么样？</h2>
    <p className="as-note">只用于生成你的形象，不会显示给任何人。</p>
    <Segments name="presentation" legend="性别呈现" choices={entries(APPEARANCE_LABELS.presentation)} value={draft.presentation}
      onChange={(value) => set({ presentation: value as Appearance["presentation"] })} />
    <Segments name="hair" legend="发型" choices={entries(APPEARANCE_LABELS.hair)} value={draft.hair}
      onChange={(value) => set({ hair: value as Appearance["hair"] })} />
    <Segments name="glasses" legend="眼镜" choices={GLASSES} value={glasses} onChange={(value) => set({ glasses: value === "yes" })} />
    <Segments name="skin" legend="肤色" choices={entries(APPEARANCE_LABELS.skin)} value={draft.skin}
      onChange={(value) => set({ skin: value as Appearance["skin"] })} />
    <Segments name="style" legend="穿衣风格" choices={entries(APPEARANCE_LABELS.style)} value={draft.style}
      onChange={(value) => set({ style: value as Appearance["style"] })} />
    <label className="as-field">
      <span>补充描述（可选）</span>
      <input type="text" value={draft.note} maxLength={NOTE_MAX * 2} placeholder="比如：红色短发、常戴帽子" autoComplete="off"
        onChange={(event) => set({ note: event.target.value })} aria-describedby="as-note-count" />
      <small id="as-note-count" className="as-note">{charCount(draft.note.trim())} / {NOTE_MAX}</small>
    </label>
    {problem && <p className="as-error" role="alert">{problem}</p>}
    <div className="as-nav">
      <button type="button" onClick={onBack}>上一步</button>
      <button type="button" className="as-primary" onClick={submit}>下一步</button>
    </div>
  </section>;
}
