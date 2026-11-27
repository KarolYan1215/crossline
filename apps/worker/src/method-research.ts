import {
  aiToolBrief, METHOD_RESEARCH_SCHEMA, METHOD_RESEARCH_SETTING, METHOD_RESEARCH_SKILL, readMethodResearch, screenMethodResearch,
  validateMethodResearch, type MethodResearch, type StoredMethodResearch
} from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import { aiToolsFor, type CrosslineStore } from "@crossline/db";
import { claimedTitleMatches } from "./diligence";
import { drillBackingFor } from "./drill-backing";
import { identityLines } from "./lines";
import { localeOf } from "./locale";
import { ownerOf } from "./owner";
import { defaultSafeGetDeps, htmlToText, safeGet, type SafeGetDeps } from "./safe-fetch";
import { citable, citableUrls } from "./cited-urls";

const INSTRUCTIONS = "Do the crossline-line-method:research Skill and return only the requested JSON: the person's habits from their own facts, "
  + "then for each recurring kind of work in their lines the current best way to do it with AI tools, from their own files first and the web second, "
  + "fitted to their habits. Cite only what you read.";

/** The run's input: the person's confirmed facts by short id, their lines with milestones and open tasks, the AI tools they use. */
export function methodResearchInput(store: CrosslineStore, workspaceId: string, today: string) {
  const facts = store.listProfileFacts(workspaceId).filter((fact) => fact.status === "confirmed" && fact.value.trim() && !/^假设[:：]/.test(fact.value)) // i18n-ignore
    .slice(0, 120).map((fact, index) => ({ id: `f${index + 1}`, slot: fact.slot, value: fact.value.slice(0, 300) }));
  const milestones = store.listMilestones(workspaceId).filter((milestone) => milestone.status !== "archived");
  const orders = store.listWorkOrders(workspaceId).filter((order) => order.state !== "archived" && order.state !== "accepted");
  const titleOf = (order: (typeof orders)[number]) => ((order.payload as { title?: string } | undefined)?.title ?? "").trim() || order.intent;
  const lines = identityLines(store, workspaceId).map((pack) => ({ id: pack.id, label: pack.label,
    milestones: milestones.filter((milestone) => milestone.identityId === pack.id).map((milestone) => milestone.title).slice(0, 8),
    tasks: orders.filter((order) => order.identityId === pack.id).map((order) => titleOf(order).slice(0, 80)).slice(0, 12) }));
  return { version: "crossline.method-research.v1", today, locale: localeOf(store, workspaceId) ?? "zh-CN", facts, lines,
    aiTools: aiToolsFor(store, workspaceId).map(aiToolBrief) };
}

/** Each web page opened (public https on every hop) and its title matched; a method resting only on dropped pages goes too. */
/** `known`: where pages may be opened (`citableUrls`); a cited address outside it is dropped unopened. */
export async function verifyMethodSources(research: MethodResearch, deps: SafeGetDeps, known?: readonly string[]): Promise<{ research: MethodResearch; dropped: number }> {
  const kept = new Set<string>();
  for (const source of research.sources) {
    if (source.local) { kept.add(source.id); continue; }
    if (!citable(source.url, known)) continue;
    const page = await safeGet(source.url, deps, { maxBytes: 3_000_000, timeoutMs: 20_000 }).catch(() => undefined);
    if (!page?.ok) continue;
    if (page.contentType === "application/pdf" || claimedTitleMatches(source.title, htmlToText(new TextDecoder().decode(page.bytes)).slice(0, 20_000))) kept.add(source.id);
  }
  const methods = research.methods.map((method) => ({ ...method, sourceIds: method.sourceIds.filter((id) => kept.has(id)) }))
    .filter((method) => method.sourceIds.length > 0);
  return { research: { ...research, methods, sources: research.sources.filter((source) => kept.has(source.id)) }, dropped: research.sources.length - kept.size };
}

export function readStoredMethodResearch(store: CrosslineStore, workspaceId: string): StoredMethodResearch | undefined {
  return readMethodResearch(store.getSetting(workspaceId, METHOD_RESEARCH_SETTING));
}

/**
 * Whether the research is due: the interview has been finished (a finish request or a complete session) after the last research, or there
 * is none yet. A re-finished interview (new answers) is researched again.
 */
export function methodResearchDue(store: CrosslineStore, workspaceId: string): boolean {
  const finished = store.listEvents(workspaceId, { type: "onboarding.changed", change: "finish_requested" }).at(-1)?.createdAt;
  if (!finished) return false;
  const last = readStoredMethodResearch(store, workspaceId)?.at;
  return !last || last < finished;
}

/**
 * One research run (the owner, 2026-11-18): habits from the person's facts, methods from their files and the web, every web page opened,
 * drill forms they never named cut (`screenMethodResearch`). Stored whole as `method.research`; planners read it through `personProfileFor`.
 */
export async function runMethodResearch(store: CrosslineStore, workspaceId: string, cwd: string,
  deps: { client: CodexRpcBoundary; safeGet?: SafeGetDeps; now?: Date; signal?: AbortSignal }): Promise<StoredMethodResearch | { blocked: string }> {
  const now = deps.now ?? new Date();
  const input = methodResearchInput(store, workspaceId, now.toISOString().slice(0, 10));
  const result = await runCodexSkill<MethodResearch>(deps.client, input, { skillName: METHOD_RESEARCH_SKILL, cwd, developerInstructions: INSTRUCTIONS,
    outputSchema: METHOD_RESEARCH_SCHEMA, prepareInput: () => input, webResearch: true, onAudit: () => {}, timeoutMs: 60 * 60_000,
    stableKeys: ["facts", "aiTools", "lines"], ...(deps.signal ? { signal: deps.signal } : {}),
    validateOutput: (output) => validateMethodResearch(output, { factIds: input.facts.map((fact) => fact.id), lineIds: input.lines.map((line) => line.id) }) });
  if (!result.ok) {
    store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `method.research_blocked:${now.toISOString()}`,
      type: "job.ran", entityId: workspaceId, payload: { code: result.blocker.code, job: "method.research", state: "blocked" } });
    return { blocked: result.blocker.code };
  }
  const verified = await verifyMethodSources(result.output, deps.safeGet ?? defaultSafeGetDeps(), citableUrls(result.audit, input));
  const screened = screenMethodResearch(verified.research, drillBackingFor(store, workspaceId).backing);
  const stored: StoredMethodResearch = { ...screened, at: now.toISOString(), droppedSources: verified.dropped };
  store.setSetting(workspaceId, METHOD_RESEARCH_SETTING, JSON.stringify(stored));
  store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `method.researched:${stored.at}`, type: "job.ran",
    entityId: workspaceId, payload: { habits: stored.habits.length, methods: stored.methods.length, sources: stored.sources.length, droppedSources: stored.droppedSources, job: "method.research", state: "done" } });
  return stored;
}
