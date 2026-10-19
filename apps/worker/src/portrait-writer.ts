import { PORTRAIT_GAP_SCHEMA, PORTRAIT_SCHEMA, PORTRAIT_SCHEMA_VERSION, typeSummaryProblem, validatePortrait, type PortraitReport, AGENT_HISTORY_SUMMARY, agentHistoryLines, type AgentHistorySummary } from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import { sayDoFor, type CrosslineStore } from "@crossline/db";
import { identityLines } from "./lines";
import { ownerOf } from "./owner";

export const PORTRAIT_WRITER = "crossline:crossline-portrait-writer";
/**
 * Written before the one rewrite of a report from an older schema, so a failure is shown, not retried every tick. Per version: an account
 * rewritten for schema 2 is rewritten once more for 3 (the personal type summary).
 */
export const PORTRAIT_REWRITE_MARKER = `portrait.rewrite.v${PORTRAIT_SCHEMA_VERSION}`;
/** When the say–do part was last written against the execution record (or last attempted). */
export const PORTRAIT_GAP_AT = "portrait.gap.at";
const GAP_INTERVAL_MS = 30 * 86_400_000;

type SavedPortrait = { version: number; at: string; schema?: number; report: PortraitReport };
const readSaved = (store: CrosslineStore, workspaceId: string): SavedPortrait | null => {
  try {
    const saved = JSON.parse(store.getSetting(workspaceId, "portrait.report") ?? "null") as SavedPortrait | null;
    return saved?.report ? saved : null;
  } catch { return null; }
};

// Content-quality refusals: when the repairs run out the answer is kept in fixed order, and the page leaves out what it cannot draw.
const KEPT_WHEN_INCOMPLETE = new Set(["PORTRAIT_VALUES_INCOMPLETE", "PORTRAIT_SAY_DO_INCOMPLETE", "PORTRAIT_TYPE_SUMMARY_INVALID"]);
/** `validatePortrait` plus the type summary's own rule; a kept answer loses a summary that breaks it rather than the whole report. */
function checked(output: unknown, lineIds: string[], options: { lenient?: boolean } = {}): PortraitReport {
  const report = validatePortrait(output, lineIds, options);
  const problem = report.type ? typeSummaryProblem(report.type.summary ?? "") : null;
  if (!problem) return report;
  if (options.lenient) return { ...report, type: { ...report.type!, summary: "" } };
  throw Object.assign(new Error("PORTRAIT_TYPE_SUMMARY_INVALID"), { detail: problem });
}

const keepIncomplete = (rejection: Error, build: () => PortraitReport): PortraitReport | undefined => {
  if (!KEPT_WHEN_INCOMPLETE.has(rejection.message)) return undefined;
  try { return build(); } catch { return undefined; }
};

/**
 * Whether a background rewrite is due (decided 2026-10-12): `"schema"` once for a report written before the fixed dimensions
 * (`PORTRAIT_SCHEMA_VERSION`), and `"gap"` — the say–do part only — at most every thirty days once the execution record is long enough
 * to be drawn. Nothing while a write asked for in the last hour may still be running; a new account is written when its interview ends.
 */
export function portraitRewriteDue(store: CrosslineStore, workspaceId: string, now: Date): "first" | "schema" | "gap" | null {
  const saved = readSaved(store, workspaceId);
  const last = store.listEvents(workspaceId, { type: "portrait.requested" }).at(-1);
  if (last && now.getTime() - Date.parse(last.createdAt) < 3_600_000) return null;
  // The first report was asked for only by the interview page that saw the last round land; a person who had moved on to another page
  // (or closed it) got 「生成画像报告」 and a button instead (2026-10-15 walkthrough). Once the interview is complete, write it here.
  if (!saved) return store.getLatestOnboardingSession(workspaceId)?.state === "complete" ? "first" : null;
  if ((saved.schema ?? 1) < PORTRAIT_SCHEMA_VERSION) return store.getSetting(workspaceId, PORTRAIT_REWRITE_MARKER) ? null : "schema";
  const gapAt = store.getSetting(workspaceId, PORTRAIT_GAP_AT);
  if (gapAt && now.getTime() - Date.parse(gapAt) < GAP_INTERVAL_MS) return null;
  return sayDoFor(store, workspaceId, now).sufficient ? "gap" : null;
}

/**
 * Writes the portrait report from what the interview gathered (decided 2026-10-08): the working portrait, the lines with their order,
 * hard constraints, descriptions and long-term goals, the confirmed facts and the person's own replies, and what the execution record
 * says they did (`doing`, for the say–do part). The report is kept in the `portrait.report` setting with its schema version and every
 * version as a `portrait.written` event, so a regenerated report can be compared with the last. With `only: "gap"` the say–do part alone
 * is rewritten against today's record, on the mid tier, keeping the version (the figure is matched to it) and everything else.
 */
export function createPortraitWriter(store: CrosslineStore, workspaceId: string, cwd: string, getClient: () => CodexRpcBoundary | undefined,
  options: { only?: "gap" } = {}) {
  return async function write(): Promise<{ state: "written"; version: number } | { state: "blocked"; code: string; message: string }> {
    const client = getClient();
    if (!client) return { state: "blocked", code: "CODEX_SUPERVISOR_UNAVAILABLE", message: "模型服务不可用。" };
    const json = <T,>(key: string, fallback: T): T => { try { return JSON.parse(store.getSetting(workspaceId, key) ?? "null") ?? fallback; } catch { return fallback; } };
    const profiles = json<Record<string, { description?: string }>>("lines.profiles", {});
    const lines = identityLines(store, workspaceId).map((line) => ({ id: line.id, label: line.label, rank: line.rank ?? null, hard: Boolean(line.hard),
      goals: line.goals ?? [], description: profiles[line.id]?.description ?? "" }));
    if (!lines.length) return { state: "blocked", code: "PORTRAIT_NO_LINES", message: "尚未设定主线。" };
    const lineIds = lines.map((line) => line.id);
    const doing = sayDoFor(store, workspaceId, new Date());

    if (options.only === "gap") {
      const previous = readSaved(store, workspaceId);
      if (!previous) return { state: "blocked", code: "PORTRAIT_NONE", message: "还没有画像报告。" };
      const merged = (output: unknown) => ({ ...previous.report, gap: (output as { gap: PortraitReport["gap"] }).gap });
      const context = { version: "crossline.portrait.v1", only: "gap", previous: previous.report, lines, doing };
      const result = await runCodexSkill<PortraitReport>(client, context, { skillName: PORTRAIT_WRITER, cwd, tier: "mid",
        developerInstructions: "Rewrite only the say–do part of the portrait report as the Skill describes. Return raw JSON only.",
        outputSchema: PORTRAIT_GAP_SCHEMA, prepareInput: () => context, validateOutput: (output) => validatePortrait(merged(output), lineIds),
        softAccept: (rejection, output) => keepIncomplete(rejection, () => validatePortrait(merged(output), lineIds, { lenient: true })),
        onAudit: () => {}, timeoutMs: 60 * 60_000 });
      if (!result.ok) return { state: "blocked", code: result.blocker.code, message: result.blocker.message };
      const at = new Date().toISOString();
      store.setSetting(workspaceId, "portrait.report", JSON.stringify({ ...previous, report: result.output }));
      store.setSetting(workspaceId, PORTRAIT_GAP_AT, at);
      store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `portrait.gap_rewritten:${previous.version}:${at}`,
        type: "portrait.gap_rewritten", entityId: workspaceId, payload: { version: previous.version, gap: result.output.gap } });
      return { state: "written", version: previous.version };
    }

    const session = store.getLatestOnboardingSession(workspaceId);
    let budget = 12_000;
    const replies = (session ? store.listOnboardingMessages(workspaceId, session.id) : []).filter((message) => message.role === "user")
      .map((message) => String((message.content as { text?: string }).text ?? "")).reverse()
      .filter((text) => { budget -= text.length; return budget > 0; }).reverse();
    const facts = store.listProfileFacts(workspaceId).filter((fact) => fact.status === "confirmed" || fact.slot.startsWith("flywheel_")).slice(0, 120)
      .map(({ identityId, projectId, slot, value, status }) => ({ identityId, projectId, slot, value, status }));
    // What the person handed over about themselves (a profile, a CV, notes) — files not filed under any one project — read as well.
    let room = 24_000;
    const documents = store.listSourceDocuments(workspaceId).filter((doc) => !doc.projectId && doc.extractionStatus === "done" && doc.extractedText.trim())
      .map((doc) => { const text = doc.extractedText.slice(0, Math.max(0, Math.min(12_000, room))); room -= text.length; return { fileName: doc.fileName, text }; })
      .filter((doc) => doc.text);
    // How the person actually spends their working hours with coding agents (time only, when they allowed it): evidence of habit, not a plan.
    const workHistory = agentHistoryLines(json<AgentHistorySummary | null>(AGENT_HISTORY_SUMMARY, null));
    const context = { version: "crossline.portrait.v1", lines, profile: json<Record<string, unknown>>("profile.model", {}), facts, replies, documents, doing,
      ...(workHistory.length ? { workHistory } : {}) };
    const result = await runCodexSkill<PortraitReport>(client, context, { skillName: PORTRAIT_WRITER, cwd,
      developerInstructions: "Write the person's portrait report as the Skill describes, from the supplied material only: the report they get "
        + "right after the interview, a shareable first half and a private second half. Every sentence specific to this person, in their own concrete "
        + "terms; long-term goals are the ones they chose, never an achievement dressed as one. Return raw JSON only.",
      outputSchema: PORTRAIT_SCHEMA, prepareInput: () => context, validateOutput: (output) => checked(output, lineIds),
      softAccept: (rejection, output) => keepIncomplete(rejection, () => checked(output, lineIds, { lenient: true })),
      onAudit: () => {}, timeoutMs: 60 * 60_000 });
    if (!result.ok) return { state: "blocked", code: result.blocker.code, message: result.blocker.message };
    const version = store.listEvents(workspaceId, { type: "portrait.written" }).length + 1;
    const at = new Date().toISOString();
    store.setSetting(workspaceId, "portrait.report", JSON.stringify({ version, at, schema: PORTRAIT_SCHEMA_VERSION, report: result.output }));
    // Written against a record long enough to draw: the say–do part is current, and the monthly rewrite counts from now.
    if (doing.sufficient) store.setSetting(workspaceId, PORTRAIT_GAP_AT, at);
    store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `portrait.written:${version}:${at}`, type: "portrait.written",
      entityId: workspaceId, payload: { version, report: result.output } });
    return { state: "written", version };
  };
}
