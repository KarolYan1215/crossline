"use client";

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

export const STAGES: Array<[string, string]> = [["orientation", "开场与规则"], ["lines", "主线"], ["situation", "现状"], ["compass", "指南针"], ["energy", "能量"], ["details", "细节"]];

/** Where the interview is, as a row of stages. */
export function StageBar({ stage, line }: { stage: string; line?: string | undefined }) {
  const t = useT();
  if (line) return <ol className="ob-stages"><li data-state="current">{t("{{line}} · 细节", { line })}</li></ol>;
  const at = Math.max(0, STAGES.findIndex(([id]) => id === stage));
  return <ol className="ob-stages" aria-label={t("访谈阶段")}>{STAGES.map(([id, label], index) =>
    <li key={id} data-state={index < at ? "done" : index === at ? "current" : "next"}>{t(label)}</li>)}</ol>;
}
