import { FAMILIARITY_LEVELS, FAMILIARITY_SETTING, familiarityKey, type AccessContext, type FamiliarityLevel } from "@crossline/core";
import { getStore } from "./crossline";

/**
 * The person's own word on how familiar a kind of work is (walkthrough W-154): kept per line and archetype in `tasks.familiarity`, so
 * every task of that line and kind is prepared and planned at that level (`familiarityFor` reads it before the rules), and noted as a
 * correction preference so the step planner sees it in the person's words too.
 */
export function setFamiliarity(ctx: AccessContext, workOrderId: string, level: FamiliarityLevel): { ok: true } | { ok: false; code: string } {
  if (!FAMILIARITY_LEVELS.includes(level)) return { ok: false, code: "FAMILIARITY_INVALID" };
  const store = getStore();
  const order = store.getWorkOrder(ctx.workspaceId, workOrderId);
  if (!order) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  const archetypeId = store.getStepPlan(ctx.workspaceId, workOrderId)?.archetypeId;
  let map: Record<string, string> = {};
  try { map = JSON.parse(store.getSetting(ctx.workspaceId, FAMILIARITY_SETTING) ?? "{}") as Record<string, string>; } catch { map = {}; }
  const key = familiarityKey(order.identityId, archetypeId);
  map[key] = level;
  store.setSetting(ctx.workspaceId, FAMILIARITY_SETTING, JSON.stringify(map));
  // i18n-ignore-start: a note in the planner's input, never shown as interface text
  const text = level === "near" ? "本人熟悉这类工作：只给要点和第一步，不解释基础概念"
    : level === "far" ? "本人对这类工作不熟：解释术语、给例子和常见错误" : "这类工作按一般熟悉程度准备";
  // i18n-ignore-end
  store.addPreference({ workspaceId: ctx.workspaceId, source: "correction", scope: order.identityId, text: `${archetypeId ? `${archetypeId}: ` : ""}${text}`,
    weight: 1, refId: `familiarity:${key}` });
  return { ok: true };
}
