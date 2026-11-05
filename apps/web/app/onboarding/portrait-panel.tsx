"use client";

import { interviewParts, PART_LABEL, type InterviewFlow, type OnboardingDepth } from "@crossline/core";
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

/**
 * The parts of the main interview in its flow's order (2026-10-19: the details stage is gone; a session stored at `details` reads as past
 * the last part). A new interview runs the profile module first (`v2`, 2026-10-31): its six parts begin with the life story. The tier
 * counts too (the thorough ones end with the details part), as in `progressView`.
 */
export const stagesOf = (flow: InterviewFlow = "v1", depth?: OnboardingDepth): Array<[string, string]> => interviewParts(flow, depth).map((id) => [id, PART_LABEL[id]]);

/**
 * Where the interview is, as a progress bar (2026-10-28 redesign): one segment per part, filled up to the current one, and the part's name
 * in words. Nothing in it can be pressed — the parts used to look like tabs and were not — so it is drawn as a bar, not as buttons.
 * `progress` is the state route's `progressView`, the count the right column shows too: given, the bar shows that part (W-186: the bar and
 * the right column counted from two different records and disagreed).
 */
export function StageBar({ stage, line, flow, depth, progress }: { stage: string; line?: string | undefined; flow?: InterviewFlow | undefined;
  depth?: OnboardingDepth | undefined; progress?: { index: number; total: number; label: string } | undefined }) {
  const t = useT();
  const STAGES = stagesOf(flow, depth);
  if (line) return <p className="ob-stagebar-caption">{t("{{line}} · 细节", { line })}</p>;
  const past = stage === "details" && !STAGES.some(([id]) => id === "details");
  const at = past ? STAGES.length : progress ? Math.max(0, Math.min(progress.index, STAGES.length) - 1) : Math.max(0, STAGES.findIndex(([id]) => id === stage));
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
