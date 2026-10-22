import { createHash } from "node:crypto";
import {
  mineFactLabel, MINE_SKILL_SCHEMA, applyMineChanges, currentMineVersion, keepMineSkill, mineMaterialId, mineSkillSettingKey, mineTextHash, readMineSkill,
  renderMineSkill, resolveMineSources, validateMineSkill, type MineMaterial, type MineRule, type MineSkillCompilation, type MineSkillContext, type PreviousMineRule
} from "@crossline/core";
import { runCodexSkill, webResearchBlocker, type CodexRpcBoundary } from "@crossline/codex";
import { listAgentTasks, saveMineVersion, type CrosslineStore, type StoredPreference } from "@crossline/db";
import { identityLines } from "./lines";
import { ownerOf } from "./owner";
import { defaultSafeGetDeps, safeGet, type SafeGetDeps } from "./safe-fetch";

export const INSIGHT_COMPILER = "crossline:crossline-insight-compiler";

/** Facts alone change often during an interview; a rewrite on facts only waits this long after the last one. */
const FACT_ONLY_REWRITE_HOURS = 24;
/** A run that failed for any other reason than the model's own stop is tried again on the same materials after this long. */
const FAILED_RETRY_HOURS = 1;
const MAX_FACTS = 60;

const INSTRUCTIONS = "Compile the person's own skill for this one line from the supplied materials, as the Skill describes: only how "
  + "this person does this line's work — their plays, preferences and hard red lines — never generic methodology. Every rule cites the "
  + "material ids it rests on and copies a quote verbatim from one of them. A platform red line (a rule whose breach gets content "
  + "punished) may instead rest on one public https page you found with web search. `materials` are only what is new or changed since "
  + "`previousRules` were compiled; answer with changes: `add` a rule, `revise` or `drop` a previous one by its ruleId when a new material "
  + "bears on it. A previous rule you do not name stays as it is. A rule may cite the materials given or a previous rule's sources. "
  + "With previousRules, leave `summary` empty unless the changes alter it. Return raw JSON only.";

/** Preferences that say how the work is done; estimates, importance and postponements are scheduling, not a play. */
const PLAY_SOURCES = new Set<StoredPreference["source"]>(["correction", "retrospective", "standard_confirmed", "relation_rejected"]);
const PREFERENCE_LABEL: Partial<Record<StoredPreference["source"], string>> = {
  correction: "本人的纠正", retrospective: "里程碑回顾", standard_confirmed: "本人确认的标准", relation_rejected: "本人否决的跨线关系"
};
const day = (iso: string) => iso.slice(0, 10);
const short = (text: string, max = 30) => (text.length > max ? `${text.slice(0, max)}…` : text);

/**
 * Everything the person said or decided about this line, as the compiler is shown it, each with a stable key (for the fingerprint) and a
 * label written here (what the SKILL.md cites): confirmed interview facts, preferences, notes on the assistant's results, the gate's
 * 「部分」 explanations, and — when the person edited the skill by hand — that edit.
 */
export function mineMaterials(store: CrosslineStore, workspaceId: string, lineId: string): Array<MineMaterial & { key: string }> {
  const orders = store.listWorkOrders(workspaceId);
  const onLine = new Map(orders.filter((order) => order.identityId === lineId).map((order) => [order.id, order]));
  const tasks = new Map(listAgentTasks(store, workspaceId).map((task) => [task.taskId, task]));
  const found: Array<Omit<MineMaterial, "id"> & { key: string }> = [];

  for (const event of store.listEvents(workspaceId, { type: "agent.task.reviewed" })) {
    const note = String((event.payload as { note?: unknown }).note ?? "").trim();
    const task = tasks.get(event.entityId);
    if (!note || !task || !onLine.has(task.workOrderId)) continue;
    const decision = (event.payload as { decision?: string }).decision === "accepted" ? "采纳" : "退回";
    found.push({ key: `review:${event.eventId}`, kind: "review", text: note, at: event.createdAt,
      label: `${day(event.createdAt)} 本人${decision}助手结果「${short(task.title)}」时的备注` });
  }
  for (const entry of store.listPreferences(workspaceId)) {
    if (!PLAY_SOURCES.has(entry.source)) continue;
    const taskId = entry.scope.startsWith("task:") ? entry.scope.slice(5) : "";
    if (entry.scope !== lineId && !onLine.has(taskId)) continue;
    found.push({ key: `pref:${entry.id}`, kind: "preference", text: entry.text, at: entry.createdAt,
      label: `${day(entry.createdAt)} ${PREFERENCE_LABEL[entry.source] ?? "本人的偏好"}` });
  }
  for (const order of onLine.values()) {
    const review = (order.payload as { gateReview?: { verdict?: string; fit?: { fits: boolean; violated: string[]; why: string } } }).gateReview;
    if (review?.verdict !== "partial" || !review.fit || review.fit.fits) continue;
    const judged = store.listEvents(workspaceId, { type: "milestone_gate.judged", entityId: order.id }).at(-1);
    found.push({ key: `gate:${order.id}:${judged?.eventId ?? ""}`, kind: "gate", at: judged?.createdAt ?? "",
      text: `违背：${review.fit.violated.join("；")}。${review.fit.why}`, label: `${day(judged?.createdAt ?? "")} 验收判「${short(order.intent)}」为部分符合` });
  }
  const stored = readMineSkill(store.getSetting(workspaceId, mineSkillSettingKey(lineId)));
  const current = currentMineVersion(stored);
  if (current?.by === "person") {
    found.push({ key: `edit:v${current.version}`, kind: "edit", text: current.markdown, at: current.at, label: `${day(current.at)} 本人编辑的第 ${current.version} 版` });
  }
  const facts = store.listProfileFacts(workspaceId, { identityId: lineId }).filter((fact) => fact.status === "confirmed")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_FACTS);
  for (const fact of facts) {
    found.push({ key: `fact:${fact.projectId}/${fact.slot}`, kind: "fact", at: fact.updatedAt,
      text: `${fact.value}${fact.sourceQuote && fact.sourceQuote !== fact.value ? `（原话：${fact.sourceQuote}）` : ""}`,
      label: mineFactLabel(fact.slot, fact.value) });
  }
  // Ids from the stable keys (they used to be positions, m1 m2 …, so one new material renumbered every later one).
  const taken = new Set<string>();
  return found.map((material) => ({ ...material, id: mineMaterialId(material.key, taken) }));
}

export const mineMaterialsFingerprint = (materials: Array<{ key: string; text: string }>) =>
  createHash("sha256").update(materials.map((material) => `${material.key}\0${material.text}`).sort().join("\n")).digest("hex").slice(0, 32);

/**
 * Lines whose skill is out of date with what the person has said since: the materials' fingerprint moved from the one the last compiled
 * version was made from. Something the person decided (a review note, a correction, a gate 「部分」, an edit) rewrites at once; facts alone
 * at most once a day, and a line with neither nothing new to say nor three confirmed facts is left alone. A line the compiler last
 * stopped on (its `*_BLOCKED`: the materials say nothing about how the work is done) waits until they change, and one whose run failed
 * waits an hour: on 2026-10-21 one line was refused 13 times in a day on the same 7,440 input tokens, and as the first line waiting it
 * kept every later line from being compiled.
 */
export function linesAwaitingMineSkill(store: CrosslineStore, workspaceId: string, now = new Date()): string[] {
  return identityLines(store, workspaceId).filter((line) => {
    const materials = mineMaterials(store, workspaceId, line.id);
    const decided = materials.filter((material) => material.kind !== "fact");
    if (!decided.length && materials.length < 3) return false;
    const blocked = store.listEvents(workspaceId, { type: "skill.mine.blocked", entityId: line.id }).at(-1)?.payload as
      { fingerprint?: string; code?: string; at?: string } | undefined;
    if (blocked?.fingerprint && blocked.fingerprint === mineMaterialsFingerprint(materials)
      && (blocked.code?.endsWith("_BLOCKED") || now.getTime() - Date.parse(blocked.at ?? "") < FAILED_RETRY_HOURS * 3_600_000)) return false;
    const stored = readMineSkill(store.getSetting(workspaceId, mineSkillSettingKey(line.id)));
    // A version the person wrote or brought back stays in force until they decide something new; facts alone never replace it.
    const current = currentMineVersion(stored);
    if (current?.by === "person") return decided.some((material) => material.kind !== "edit" && material.at > current.at);
    const compiled = stored?.versions.filter((version) => version.by === "compiler").at(-1);
    const fingerprint = mineMaterialsFingerprint(materials);
    if (compiled?.fingerprint === fingerprint) return false;
    if (!compiled) return true;
    const newDecision = decided.some((material) => material.at > compiled.at);
    return newDecision || now.getTime() - Date.parse(compiled.at) >= FACT_ONLY_REWRITE_HOURS * 3_600_000;
  }).map((line) => line.id);
}

/**
 * Compiles one line's skill (the first waiting, or `lineId`). The model proposes rules; the worker keeps only rules resting on the
 * person's own material (a quote that is really in it) or, for a platform red line, on a public page that actually opens, renders the
 * SKILL.md itself, and stores it as a new version. A line whose run fails keeps the version it had.
 */
export function createInsightCompiler(store: CrosslineStore, workspaceId: string, cwd: string, getClient: () => CodexRpcBoundary | undefined,
  deps: { safeGet?: SafeGetDeps; now?: () => Date } = {}) {
  return async function compile(lineId?: string): Promise<{ lineId: string; version: number; rules: number; dropped: string[] } | { blocked: string; lineId?: string } | undefined> {
    const client = getClient();
    if (!client) return { blocked: "CODEX_SUPERVISOR_UNAVAILABLE" };
    const now = deps.now?.() ?? new Date();
    const target = lineId ?? linesAwaitingMineSkill(store, workspaceId, now)[0];
    if (!target) return undefined;
    const line = identityLines(store, workspaceId).find((item) => item.id === target);
    if (!line) return { blocked: "LINE_NOT_FOUND", lineId: target };
    const materials = mineMaterials(store, workspaceId, target);
    const all: MineMaterial[] = materials.map(({ key: _key, ...material }) => material);
    const fingerprint = mineMaterialsFingerprint(materials);
    const materialHashes = Object.fromEntries(all.map((material) => [material.id, mineTextHash(material.text)]));
    const blocked = (code: string, message = "") => {
      store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `skill.mine:blocked:${target}:${now.getTime()}`,
        type: "skill.mine.blocked", entityId: target, payload: { lineId: target, code, message: message.slice(0, 400), fingerprint, at: now.toISOString() } });
      return { blocked: code, lineId: target };
    };
    const previous = currentMineVersion(readMineSkill(store.getSetting(workspaceId, mineSkillSettingKey(target))));
    // Incremental (token-economy.md §2): on top of a compiled version that recorded its materials, only what is new or changed since is
    // shown, beside that version's rules with their sources. Anything else — a version the person wrote, one compiled before — is rebuilt
    // from every material, its rules still offered (their sources found again by their quotes).
    const base = previous?.by === "compiler" ? previous.materialHashes : undefined;
    const shown = base ? all.filter((material) => base[material.id] !== materialHashes[material.id]) : all;
    const previousRules: PreviousMineRule[] = (previous?.rules ?? []).map((rule, index) => ({ id: `r${index + 1}`, kind: rule.kind, text: rule.text,
      sources: resolveMineSources(rule, all), quote: rule.quote, url: rule.url }));
    const cited = new Set(previousRules.flatMap((rule) => rule.sources));
    const citable = [...shown, ...all.filter((material) => cited.has(material.id) && !shown.includes(material))];
    const context: MineSkillContext = { version: "crossline.mine-skill.v2", today: now.toISOString().slice(0, 10),
      line: { id: line.id, label: line.label, goals: line.goals ?? [] }, materials: shown, previousRules };

    let answer: MineSkillCompilation = { summary: "", rules: [], blockers: [] };
    // Nothing new or changed (a material was only removed): no model run; the rules that rested on it go.
    if (shown.length) {
      // Web search finds a platform's written red lines; without the runtime's search host the run still compiles the person's own rules.
      const web = !webResearchBlocker();
      const result = await runCodexSkill<MineSkillCompilation>(client, context, {
        skillName: INSIGHT_COMPILER, cwd, developerInstructions: INSTRUCTIONS,
        // The prompt cache (docs/token-economy.md §2.5): the line and its material before the previous rules and the date.
        stableKeys: ["version", "line", "materials", "previousRules"],
        ...(web ? {} : { runNote: "Web search is unavailable: write no url-only red line." }),
        outputSchema: MINE_SKILL_SCHEMA, prepareInput: () => context, ...(web ? { allowWebSearch: true } : {}),
        validateOutput: (output) => validateMineSkill(output, context, citable),
        softAccept: (_rejection, output) => keepMineSkill(output, context, citable),
        onAudit: () => {}, timeoutMs: 60 * 60_000
      });
      if (!result.ok) return blocked(result.blocker.code, result.blocker.message);
      answer = result.output;
    }
    const applied = applyMineChanges(answer, context, citable);
    const dropped = [...applied.dropped];
    const rules: MineRule[] = [];
    const known = new Set((previous?.rules ?? []).filter((rule) => !rule.sources.length).map((rule) => rule.url));
    for (const rule of applied.rules) {
      // A url-only red line's page is opened once, when it is first written; one carried over has been.
      if (!rule.sources.length && !known.has(rule.url)) {
        const page = await safeGet(rule.url, deps.safeGet ?? defaultSafeGetDeps(), { maxBytes: 2_000_000, timeoutMs: 20_000 }).catch(() => undefined);
        if (!page?.ok) { dropped.push(`${rule.text.slice(0, 40)}：来源页面无法打开`); continue; }
      }
      rules.push(rule);
    }
    // Recorded like a failed run, so the same materials are not tried again every tick (W-114).
    if (!rules.length) return blocked("MINE_SKILL_EMPTY", dropped.join("；"));
    const at = now.toISOString();
    const summary = answer.summary.trim() || previous?.summary || "";
    const same = previous?.by === "compiler" && previous.rules?.length === rules.length && (previous.summary ?? "") === summary
      && rules.every((rule, index) => { const old = previous.rules![index]!; return old.kind === rule.kind && old.text === rule.text && old.quote === rule.quote; });
    if (same) {
      // The rules stand as they are: the version in force now records the materials it is up to date with, and nothing is rewritten.
      touchMineVersion(store, workspaceId, target, previous!.version, { fingerprint, materialHashes });
      return { lineId: target, version: previous!.version, rules: rules.length, dropped };
    }
    const stored = readMineSkill(store.getSetting(workspaceId, mineSkillSettingKey(target)));
    const number = Math.max(0, ...(stored?.versions ?? []).map((item) => item.version)) + 1;
    const rendered = renderMineSkill({ line: { id: line.id, label: line.label }, version: number, at, summary, rules, materials: all });
    saveMineVersion(store, workspaceId, target, { at, by: "compiler", markdown: rendered.markdown, rules: rendered.rules, fingerprint, materialHashes, summary });
    return { lineId: target, version: number, rules: rules.length, dropped };
  };
}

/** Records on a version what it is up to date with, without a new version (the rules did not change). */
function touchMineVersion(store: CrosslineStore, workspaceId: string, lineId: string, version: number,
  update: { fingerprint: string; materialHashes: Record<string, string> }): void {
  const stored = readMineSkill(store.getSetting(workspaceId, mineSkillSettingKey(lineId)));
  if (!stored) return;
  store.setSetting(workspaceId, mineSkillSettingKey(lineId), JSON.stringify({ ...stored,
    versions: stored.versions.map((item) => item.version === version ? { ...item, ...update } : item) }));
}
