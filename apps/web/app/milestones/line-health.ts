import { riskLevelOf, type MilestoneRisk } from "@crossline/core";
import type { MilestoneState } from "../../lib/plan-stats";

/** How a line stands, as its card says it (Linear's project health: on track / at risk / off track), always labelled an estimate. */
export type LineHealth = { level: "ok" | "watch" | "risk";
  /** Of the line's approved milestones not yet reached: how many the schedule or the reviewer puts at risk, and how many want attention. */
  risky: number; watch: number; open: number;
  /** Milestones reached against all live ones (drafts included), for the progress bar. */
  reached: number; total: number };

type MilestoneLike = { identityId: string; status: "draft" | "approved"; risks: MilestoneRisk[]; planStates?: MilestoneState[] | undefined;
  retrospective?: unknown };

/**
 * A line's health from what is already on record, no model: an approved, unreached milestone the schedule cannot finish in time
 * (`planStates` risk) or the reviewer rates high is at risk; one rated medium, or with nothing ready to work on, wants attention.
 * Null while the line has no approved milestone to judge — a card then shows no health at all rather than a reassuring one.
 */
export function lineHealth(milestones: MilestoneLike[], line: string): LineHealth | null {
  const own = milestones.filter((item) => item.identityId === line);
  const open = own.filter((item) => item.status === "approved" && !item.retrospective);
  const reached = own.filter((item) => item.retrospective).length;
  if (!own.some((item) => item.status === "approved")) return null;
  const risky = open.filter((item) => item.planStates?.includes("risk") || riskLevelOf(item.risks) === "high").length;
  const watch = open.filter((item) => !(item.planStates?.includes("risk") || riskLevelOf(item.risks) === "high")
    && (riskLevelOf(item.risks) === "medium" || item.planStates?.includes("unprepared"))).length;
  return { level: risky ? "risk" : watch ? "watch" : "ok", risky, watch, open: open.length, reached, total: own.length };
}
