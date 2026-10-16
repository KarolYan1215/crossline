"use client";

import { useState } from "react";
import { APPEARANCE_LABELS, NOTE_MAX, type Appearance } from "../lib/contract";
import { appearanceProblem, charCount, type AppearanceDraft } from "../lib/flow";
import { useLocale, useT } from "./locale-context";

type Choice = { value: string; label: string };
const GLASSES: Choice[] = [{ value: "yes", label: "戴眼镜" }, { value: "no", label: "不戴" }];
const entries = (labels: Record<string, string>): Choice[] => Object.entries(labels).map(([value, label]) => ({ value, label }));

/** A row of choices that reads as one control: a native radio group whose labels are the segments. */
function Segments({ name, legend, choices, value, onChange }: {
  name: string; legend: string; choices: Choice[]; value: string | undefined; onChange: (value: string) => void;
}) {
  const t = useT();
  return <fieldset className="as-segments">
    <legend>{legend}</legend>
    <div>{choices.map((choice) => <label key={choice.value} data-on={value === choice.value || undefined}>
      <input type="radio" name={name} value={choice.value} checked={value === choice.value} onChange={() => onChange(choice.value)} />
      <span>{t(choice.label)}</span>
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
  const locale = useLocale();
  const t = useT();
  const set = (patch: Partial<AppearanceDraft>) => { const updated = { ...draft, ...patch }; onChange(updated); if (problem) setProblem(appearanceProblem(updated, locale)); };
  const submit = () => { const found = appearanceProblem(draft, locale); setProblem(found); if (!found) onNext(); };
  const glasses = draft.glasses === undefined ? undefined : draft.glasses ? "yes" : "no";

  return <section className="as-sheet">
    <p className="as-kicker">{t("最后三步 · {{step}} / 3", { step: 1 })}</p>
    <h2>{t("你大概长什么样？")}</h2>
    <p className="as-note">{t("这些选项只用来画你海报上的形象，选项本身不会给别人看。")}</p>
    <Segments name="presentation" legend={t("性别呈现")} choices={entries(APPEARANCE_LABELS.presentation)} value={draft.presentation}
      onChange={(value) => set({ presentation: value as Appearance["presentation"] })} />
    <Segments name="hair" legend={t("发型")} choices={entries(APPEARANCE_LABELS.hair)} value={draft.hair}
      onChange={(value) => set({ hair: value as Appearance["hair"] })} />
    <Segments name="glasses" legend={t("眼镜")} choices={GLASSES} value={glasses} onChange={(value) => set({ glasses: value === "yes" })} />
    <Segments name="skin" legend={t("肤色")} choices={entries(APPEARANCE_LABELS.skin)} value={draft.skin}
      onChange={(value) => set({ skin: value as Appearance["skin"] })} />
    <Segments name="style" legend={t("穿衣风格")} choices={entries(APPEARANCE_LABELS.style)} value={draft.style}
      onChange={(value) => set({ style: value as Appearance["style"] })} />
    <label className="as-field">
      <span>{t("补充描述（可选）")}</span>
      <input type="text" value={draft.note} maxLength={NOTE_MAX * 2} placeholder={t("比如：红色短发、常戴帽子")} autoComplete="off"
        onChange={(event) => set({ note: event.target.value })} aria-describedby="as-note-count" />
      <small id="as-note-count" className="as-note">{charCount(draft.note.trim())} / {NOTE_MAX}</small>
    </label>
    {problem && <p className="as-error" role="alert">{problem}</p>}
    <div className="as-nav">
      <button type="button" onClick={onBack}>{t("上一步")}</button>
      <button type="button" className="as-primary" onClick={submit}>{t("下一步", { context: "button" })}</button>
    </div>
  </section>;
}
