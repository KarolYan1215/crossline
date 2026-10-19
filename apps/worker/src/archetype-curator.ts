import { ARCHETYPES, ARCHETYPE_CURATION_SCHEMA, archetypeBrief, validateCuratedArchetypes, type Archetype, type CuratedArchetype } from "@crossline/core";
import { runCodexSkill, webResearchBlocker, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { defaultSafeGetDeps, safeGet, type SafeGetDeps } from "./safe-fetch";
import { ownerOf } from "./owner";

export const ARCHETYPE_CURATOR = "crossline:crossline-archetype-curator";
const PERIOD_SETTING = "archetypes.curation.period";
const PERIOD_DAYS = { biweekly: 14, monthly: 30 } as const;
/** New preferences since the last run that bring the next one forward, whatever the period. */
export const CURATION_PREFERENCE_TRIGGER = 20;
/** Without this many planned tasks there is no history to draw an archetype from. */
const MIN_PLANNED_TASKS = 8;

const INSTRUCTIONS = "Propose at most three new task archetypes, the grammars the step planner splits tasks by, only for work this person "
  + "repeats (two or more of the listed task ids) that its archetype fitted badly; return none, saying why in notes, when the existing ones "
  + "suffice. Build each from the given primitives and roles with a few ordering rules, shares, a size formula from the tasks' real sizes, a "
  + "recognised acceptance standard and a tick phrasing, and ground it in at least one public standard or method page you opened (https URL "
  + "and its title). Return raw JSON only.";

/** Learned archetypes in the shape the step planner and its checks use. */
export const learnedArchetypes = (store: CrosslineStore, workspaceId: string): Archetype[] =>
  store.listLearnedArchetypes(workspaceId).map((row) => row.archetype as Archetype);

/**
 * Whether a curation run is due: the person's period (every two weeks by default, monthly, or off) since the last run, or twenty new
 * preferences since then — and only once there are enough planned tasks to learn from.
 */
export function curationDue(store: CrosslineStore, workspaceId: string, now = new Date()): boolean {
  const period = store.getSetting(workspaceId, PERIOD_SETTING) ?? "biweekly";
  if (period === "off") return false;
  if (store.listStepPlans(workspaceId).length < MIN_PLANNED_TASKS) return false;
  const last = store.listEvents(workspaceId, { type: "archetypes.curated" }).at(-1)?.createdAt;
  if (!last) return true;
  const days = (now.getTime() - Date.parse(last)) / 86_400_000;
  const fresh = store.listPreferences(workspaceId).filter((entry) => entry.createdAt > last).length;
  return days >= PERIOD_DAYS[period as keyof typeof PERIOD_DAYS] || fresh >= CURATION_PREFERENCE_TRIGGER;
}

/**
 * One curation run. The model proposes; the worker keeps only archetypes that pass the shape checks and whose cited source actually
 * opens (`safeGet`: public host on every hop); everything dropped is recorded with its reason in `archetypes.curated`.
 */
export function createArchetypeCurator(store: CrosslineStore, workspaceId: string, cwd: string, getClient: () => CodexRpcBoundary | undefined,
  deps: { safeGet?: SafeGetDeps } = {}) {
  return async function curate(): Promise<{ added: string[]; dropped: string[] } | undefined> {
    const client = getClient();
    if (!client || webResearchBlocker()) return undefined;
    const plans = store.listStepPlans(workspaceId).slice(-40);
    const orders = new Map(store.listWorkOrders(workspaceId).map((order) => [order.id, order]));
    const learned = learnedArchetypes(store, workspaceId);
    const input = {
      version: "crossline.archetype-curation.v1",
      builtin: ARCHETYPES.map(archetypeBrief), learned: learned.map(archetypeBrief),
      tasks: plans.flatMap((plan) => {
        const order = orders.get(plan.workOrderId);
        return order ? [{ id: order.id, intent: order.intent, line: order.identityId, archetypeId: plan.archetypeId, roles: plan.steps.map((step) => step.role) }] : [];
      }),
      preferences: store.preferenceLines(workspaceId, [...new Set([...orders.values()].map((order) => order.identityId))], 30)
    };
    const result = await runCodexSkill(client, input, { skillName: ARCHETYPE_CURATOR, cwd, developerInstructions: INSTRUCTIONS,
      outputSchema: ARCHETYPE_CURATION_SCHEMA, prepareInput: () => input, allowWebSearch: true, onAudit: () => {}, timeoutMs: 60 * 60_000,
      validateOutput: (output) => validateCuratedArchetypes(output, { existingIds: learned.map((item) => item.id), taskIds: input.tasks.map((task) => task.id) }) });
    if (!result.ok) return undefined;
    const added: string[] = [];
    const dropped = [...result.output.dropped];
    for (const archetype of result.output.kept) {
      const opened = await firstSourceThatOpens(archetype, deps.safeGet ?? defaultSafeGetDeps());
      if (!opened) { dropped.push(`${archetype.id}：来源无法打开`); continue; }
      const { basedOnTaskIds, sources, why, ...shape } = archetype;
      store.saveLearnedArchetype(workspaceId, shape, { basedOnTaskIds, sources, why, verifiedSource: opened });
      added.push(archetype.id);
    }
    store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `archetypes.curated:${Date.now()}`, type: "archetypes.curated",
      entityId: workspaceId, payload: { added, dropped } });
    return { added, dropped };
  };
}

async function firstSourceThatOpens(archetype: CuratedArchetype, deps: SafeGetDeps): Promise<string | undefined> {
  for (const source of archetype.sources.slice(0, 3)) {
    const page = await safeGet(source.url, deps, { maxBytes: 2_000_000, timeoutMs: 20_000 }).catch(() => undefined);
    if (page?.ok) return page.finalUrl;
  }
  return undefined;
}
