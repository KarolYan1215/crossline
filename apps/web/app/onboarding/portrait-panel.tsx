"use client";
import { INTERVIEW_PARTS, PART_LABEL } from "@crossline/core";

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

/** Where the interview is, as a row of stages. */
export function StageBar({ stage, line }: { stage: string; line?: string | undefined }) {
  if (line) return <ol className="ob-stages"><li data-state="current">{line} · 细节</li></ol>;
  const at = stage === "details" ? STAGES.length : Math.max(0, STAGES.findIndex(([id]) => id === stage));
  return <ol className="ob-stages" aria-label="访谈阶段">{STAGES.map(([id, label], index) =>
    <li key={id} data-state={index < at ? "done" : index === at ? "current" : "next"}>{label}</li>)}</ol>;
}
