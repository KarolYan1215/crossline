import type { CodexRpcBoundary } from "./index";
import { tierRoutes, type ModelRoute, type RouteTier } from "./model-policy";
import { currentUsageWorkspace } from "./usage";

/**
 * The models an account may actually use, as the runtime's own catalogue says (`model/list`). The tier table names `gpt-5.6-sol`, `-terra`
 * and `-luna`, and a ChatGPT Free account is not offered all of them: every top-tier run (the interview first) asked for a model the
 * account does not have and failed (2026-10-18). The catalogue is keyed by the account's plan inside the runtime, so asking it is the one
 * honest way to know; a route is fitted to it before a thread starts.
 */
export type CatalogModel = { model: string; hidden: boolean; isDefault: boolean; efforts: string[]; defaultEffort: string };

const TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; models: CatalogModel[] | null }>();

/** Forget a workspace's catalogue: after a sign-in or sign-out the plan, and so the list, may be different. */
export function forgetAccountModels(workspaceId?: string): void {
  if (workspaceId === undefined) cache.clear(); else cache.delete(workspaceId);
}

/** The account's models, or null when the runtime cannot say (an old runtime, a failed call): then the route is left as it is. */
export async function accountModels(client: CodexRpcBoundary, workspaceId = currentUsageWorkspace() ?? "", now = Date.now()): Promise<CatalogModel[] | null> {
  const cached = cache.get(workspaceId);
  if (cached && now - cached.at < TTL_MS) return cached.models;
  let models: CatalogModel[] | null = null;
  try {
    const found: CatalogModel[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const answer = await client.request("model/list", { includeHidden: true, limit: 100, ...(cursor ? { cursor } : {}) }) as
        { data?: Array<Record<string, unknown>>; nextCursor?: string | null };
      for (const item of answer.data ?? []) {
        const model = typeof item.model === "string" ? item.model : typeof item.id === "string" ? item.id : "";
        if (!model) continue;
        const efforts = Array.isArray(item.supportedReasoningEfforts)
          ? item.supportedReasoningEfforts.map((option) => String((option as { reasoningEffort?: unknown }).reasoningEffort ?? "")).filter(Boolean) : [];
        found.push({ model, hidden: item.hidden === true, isDefault: item.isDefault === true, efforts,
          defaultEffort: typeof item.defaultReasoningEffort === "string" ? item.defaultReasoningEffort : "" });
      }
      cursor = answer.nextCursor ?? undefined;
      if (!cursor) break;
    }
    models = found.length ? found : null;
  } catch { models = null; }
  cache.set(workspaceId, { at: now, models });
  return models;
}

const LADDERS: Record<RouteTier, RouteTier[]> = { top: ["top", "mid", "low"], mid: ["mid", "low", "top"], low: ["low", "mid", "top"] };

/**
 * The route the account can run. A model it has is kept, with its effort if the model takes it (else the model's own default). A model
 * it lacks gives way to the next model of the tier ladder it has — the top tier falls to the middle, then the low — and failing all of
 * them to the account's default model, so a Free account still runs every Skill, on what it is given.
 */
export function fitRoute(route: ModelRoute | undefined, tier: RouteTier | undefined, models: CatalogModel[] | null,
  tiers: Record<RouteTier, ModelRoute> = tierRoutes()): ModelRoute | undefined {
  if (!route || !models?.length) return route;
  const byName = new Map(models.map((model) => [model.model, model]));
  // The first effort the model takes: the one asked for, then the stand-in tier's own, then the model's default.
  const withEffort = (base: ModelRoute, model: CatalogModel, wanted: Array<string | undefined> = [base.effort]): ModelRoute => {
    const { effort: _effort, ...rest } = base;
    const effort = wanted.find((item) => item && (!model.efforts.length || model.efforts.includes(item))) ?? (model.defaultEffort || undefined);
    return { ...rest, model: model.model, ...(effort ? { effort } : {}) };
  };
  const own = byName.get(route.model);
  if (own) return withEffort(route, own);
  for (const step of tier ? LADDERS[tier] : ["top", "mid", "low"] as RouteTier[]) {
    const candidate = byName.get(tiers[step].model);
    if (candidate) return withEffort({ ...route, model: tiers[step].model }, candidate, [route.effort, tiers[step].effort]);
  }
  const fallback = models.find((model) => model.isDefault) ?? models.find((model) => !model.hidden) ?? models[0]!;
  return withEffort(route, fallback);
}
