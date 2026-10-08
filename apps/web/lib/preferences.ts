import "server-only";
import type { AccessContext } from "@crossline/core";
import { defaultIdentityPacks } from "@crossline/identity-packs";
import { getStore } from "./crossline";

/** How often the archetype curator looks for new task archetypes from this person's history: off, every two weeks, or monthly. */
export const ARCHETYPE_CURATION_PERIOD = "archetypes.curation.period";
export type CurationPeriod = "off" | "biweekly" | "monthly";

const SOURCE_LABEL: Record<string, string> = { correction: "纠正", retrospective: "回顾", estimate: "估时修改", importance: "重要性",
  standard_confirmed: "本人确认", relation_rejected: "驳回关系" };

export type PreferenceRow = { id: string; source: string; sourceLabel: string; scopeLabel: string; line?: string; text: string; day: string };

/** What the system has learned about how this person works, newest first, as the settings module lists it. */
export function loadPreferences(ctx: AccessContext): { rows: PreferenceRow[]; period: CurationPeriod; learned: Array<{ id: string; label: string; source: string }> } {
  const store = getStore();
  const labels = new Map(defaultIdentityPacks().map((pack) => [pack.id, pack.label]));
  const rows = store.listPreferences(ctx.workspaceId).map((entry) => ({ id: entry.id, source: entry.source, sourceLabel: SOURCE_LABEL[entry.source] ?? entry.source,
    scopeLabel: entry.scope === "all" ? "全部" : entry.scope.startsWith("task:") ? "单个任务" : entry.scope.startsWith("archetype:") ? "任务原型" : labels.get(entry.scope) ?? entry.scope,
    ...(labels.has(entry.scope) ? { line: entry.scope } : {}), text: entry.text, day: entry.createdAt.slice(5, 10).replace("-", "/") }));
  const period = store.getSetting(ctx.workspaceId, ARCHETYPE_CURATION_PERIOD);
  const learned = store.listLearnedArchetypes(ctx.workspaceId).map((row) => ({ id: row.id, label: row.label,
    source: String((row.basis as { verifiedSource?: string }).verifiedSource ?? "") }));
  return { rows, period: period === "off" || period === "monthly" ? period : "biweekly", learned };
}
