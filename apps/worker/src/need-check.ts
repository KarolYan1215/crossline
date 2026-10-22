import { MATERIAL_SEARCH_SCHEMA, taskTitleOf, validateMaterialSearch, type MaterialSearch, type MaterialSearchContext } from "@crossline/core";
import { runCodexSkill, webResearchBlocker, type CodexRpcBoundary } from "@crossline/codex";
import { needStatesOf, recordNeedCheck, type CrosslineStore } from "@crossline/db";
import { defaultSafeGetDeps } from "./safe-fetch";
import { MATERIAL_RESEARCHER_SKILL, keepSources, type ManualbookDeps } from "./manualbook";
import { ownerOf } from "./owner";

/**
 * The second of three places material is looked for before the person is asked (decided 2026-10-22, the owner: 「先检查目前已有文件和文件夹中
 * 是否有相关材料，是否足够覆盖，搜索网络，是否有直接针对该任务的教程和方案，都不足够时才问用户要专属材料」). The step planner looked through
 * the person's files and folders and listed only material something on record says the person has (`needs` with a basis); here each such
 * need is looked for once on the web, by the tutorial's own researcher, for a tutorial, plan or resource made for this very task. A page
 * that opens settles the need (`public`, the provide step skipped, the person never asked); finding none puts the upload box in front
 * of the person. No web on this runtime: the person is asked.
 */
const QUESTIONS_PER_NEED = 2;
export const NEEDS_PER_PASS = 2;

export function needsAwaitingCheck(store: CrosslineStore, workspaceId: string): Array<{ workOrderId: string; needId: string; what: string; why: string }> {
  const out: Array<{ workOrderId: string; needId: string; what: string; why: string }> = [];
  for (const plan of store.listStepPlans(workspaceId)) {
    if (!plan.needs?.length) continue;
    const states = needStatesOf(store, workspaceId, plan.workOrderId);
    for (const need of plan.needs) if (states.get(need.id) === "checking") out.push({ workOrderId: plan.workOrderId, needId: need.id, what: need.what, why: need.why });
  }
  return out;
}

const SEARCH_INSTRUCTIONS = "Find whether a public page already gives what one task needs, so the person does not have to supply it: a tutorial, "
  + "a worked plan, a problem set or a resource made for this very task (the same course, assignment, tool or venue), or one that plainly covers "
  + "the same content at the same level. Answer every research question; list only public https pages you opened, with their real titles and "
  + "a faithful summary of what they give for this task. A general introduction to the field does not count: return no source then and say what "
  + "is missing in gaps. Return only the requested JSON, every human-readable field in Chinese.";

export function createNeedChecker(store: CrosslineStore, workspaceId: string, cwd: string, getClient: () => CodexRpcBoundary | undefined,
  deps: Partial<ManualbookDeps> & Pick<ManualbookDeps, "readCost">) {
  const all: ManualbookDeps = { safeGet: defaultSafeGetDeps(), now: () => new Date(), webBlocker: webResearchBlocker, ...deps };
  return async function check(item: { workOrderId: string; needId: string; what: string; why: string }): Promise<"public" | "ask" | "skipped"> {
    const order = store.getWorkOrder(workspaceId, item.workOrderId);
    const client = getClient();
    if (!order || !client) return "skipped";
    const ownerId = ownerOf(store, workspaceId);
    // No web on this runtime: nothing to look in, so the person is asked.
    if (all.webBlocker()) { recordNeedCheck(store, workspaceId, item.workOrderId, item.needId, [], ownerId, all.now()); return "ask"; }
    const today = all.now().toISOString().slice(0, 10);
    const task = taskTitleOf(order);
    const context: MaterialSearchContext = { version: "crossline.manualbook.search.v1", today, task: { intent: order.intent },
      node: { id: `need-${item.needId}`, title: `${task}：${item.what}`, kind: "read", goal: item.why || item.what, steps: [],
        researchQuestions: [`有没有直接针对「${task}」的「${item.what}」，或可替代它的公开教程、方案或资料？`,
          `「${item.what}」的内容在哪个公开页面可以直接获取？`].slice(0, QUESTIONS_PER_NEED) },
      localFiles: [], constraints: [] };
    const found = await runCodexSkill<MaterialSearch>(client, context, { skillName: MATERIAL_RESEARCHER_SKILL, cwd, developerInstructions: SEARCH_INSTRUCTIONS,
      outputSchema: MATERIAL_SEARCH_SCHEMA, allowWebSearch: true, stableKeys: ["version", "task"], prepareInput: () => context,
      validateOutput: (output) => validateMaterialSearch(output), onAudit: () => {}, timeoutMs: 30 * 60_000 });
    // A run that failed for the runtime's sake says nothing about the web: tried again on a later pass.
    if (!found.ok && /^(SKILL_|CODEX_)/.test(found.blocker.code)) return "skipped";
    const kept = found.ok ? await keepSources(found.output.sources, all, today, []) : [];
    recordNeedCheck(store, workspaceId, item.workOrderId, item.needId, kept.map((source) => ({ title: source.title, url: source.url })), ownerId, all.now());
    return kept.length ? "public" : "ask";
  };
}
