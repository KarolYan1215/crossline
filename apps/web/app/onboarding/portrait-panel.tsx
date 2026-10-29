"use client";

import { INTERVIEW_PARTS, PART_LABEL } from "@crossline/core";
import { useT } from "../locale-context";

export type ProfileModelView = {
  portrait: string; coreConflict: string; problem: string; gravity: string[]; designable: string[]; reframes: Array<{ fallacy: string; reframe: string }>;
  workView: string; lifeView: string; consistency: string; trueNorth: string;
  energyMap: Array<{ activity: string; skill: "high" | "low"; love: "high" | "low"; charge: "charge" | "drain" }>;
  flow: string[]; says: string; does: string; anchor: string; realWant: string; allocation: string;
  /** Schwartz values scored so far (absent on a profile written before they existed). */
  values?: Array<{ value: string; score: number }>;
};
export type LineView = { id: string; label: string; rank: number | null; hard: boolean; goals: string[]; goalParts: string[] };

/** The five parts of the main interview (2026-10-19: the details stage is gone; a session stored at `details` reads as past the last part). */
export const STAGES: Array<[string, string]> = INTERVIEW_PARTS.map((id) => [id, PART_LABEL[id]]);

/**
 * Where the interview is, as a progress bar (2026-10-28 redesign): one segment per part, filled up to the current one, and the part's name
 * in words. Nothing in it can be pressed — the parts used to look like tabs and were not — so it is drawn as a bar, not as buttons.
 */
export function StageBar({ stage, line }: { stage: string; line?: string | undefined }) {
  const t = useT();
  if (line) return <p className="ob-stagebar-caption">{t("{{line}} · 细节", { line })}</p>;
  const at = stage === "details" ? STAGES.length : Math.max(0, STAGES.findIndex(([id]) => id === stage));
  const current = STAGES[Math.min(at, STAGES.length - 1)]!;
  const label = at >= STAGES.length ? t("访谈已完成") : t("第 {{index}}/{{total}} 部分 · {{label}}", { index: at + 1, total: STAGES.length, label: t(current[1]) });
  return <div className="ob-stagebar">
    <div className="ob-stagebar-track" role="progressbar" aria-label={t("访谈阶段")} aria-valuemin={0} aria-valuemax={STAGES.length}
      aria-valuenow={Math.min(at + 1, STAGES.length)} aria-valuetext={label}>
      {STAGES.map(([id, name], index) => <i key={id} title={t(name)} data-state={index < at ? "done" : index === at ? "current" : "next"} />)}
    </div>
    <p className="ob-stagebar-caption">{label}</p>
  </div>;
}
