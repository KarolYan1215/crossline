import { PORTRAIT_SCHEMA, validatePortrait, type PortraitReport } from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { identityLines } from "./lines";
import { ownerOf } from "./owner";

export const PORTRAIT_WRITER = "crossline:crossline-portrait-writer";

/**
 * Writes the portrait report from what the interview gathered (decided 2026-10-08): the working portrait, the lines with their order,
 * hard constraints, descriptions and long-term goals, the confirmed facts and the person's own replies. The report is kept in the
 * `portrait.report` setting and every version as a `portrait.written` event, so a regenerated report can be compared with the last.
 */
export function createPortraitWriter(store: CrosslineStore, workspaceId: string, cwd: string, getClient: () => CodexRpcBoundary | undefined) {
  return async function write(): Promise<{ state: "written"; version: number } | { state: "blocked"; code: string; message: string }> {
    const client = getClient();
    if (!client) return { state: "blocked", code: "CODEX_SUPERVISOR_UNAVAILABLE", message: "模型服务不可用。" };
    const json = <T,>(key: string, fallback: T): T => { try { return JSON.parse(store.getSetting(workspaceId, key) ?? "null") ?? fallback; } catch { return fallback; } };
    const profiles = json<Record<string, { description: string; goalCandidates: string[] }>>("lines.profiles", {});
    const lines = identityLines(store, workspaceId).map((line) => ({ id: line.id, label: line.label, rank: line.rank ?? null, hard: Boolean(line.hard),
      goals: line.goals ?? [], description: profiles[line.id]?.description ?? "" }));
    if (!lines.length) return { state: "blocked", code: "PORTRAIT_NO_LINES", message: "尚未设定主线。" };
    const session = store.getLatestOnboardingSession(workspaceId);
    let budget = 12_000;
    const replies = (session ? store.listOnboardingMessages(workspaceId, session.id) : []).filter((message) => message.role === "user")
      .map((message) => String((message.content as { text?: string }).text ?? "")).reverse()
      .filter((text) => { budget -= text.length; return budget > 0; }).reverse();
    const facts = store.listProfileFacts(workspaceId).filter((fact) => fact.status === "confirmed" || fact.slot.startsWith("flywheel_")).slice(0, 120)
      .map(({ identityId, projectId, slot, value, status }) => ({ identityId, projectId, slot, value, status }));
    const context = { version: "crossline.portrait.v1", lines, profile: json<Record<string, unknown>>("profile.model", {}), facts, replies };
    const result = await runCodexSkill<PortraitReport>(client, context, { skillName: PORTRAIT_WRITER, cwd,
      developerInstructions: "Write the portrait report as the Skill describes, from the supplied material only. Return raw JSON only.",
      outputSchema: PORTRAIT_SCHEMA, prepareInput: () => context, validateOutput: (output) => validatePortrait(output, lines.map((line) => line.id)),
      onAudit: () => {}, timeoutMs: 60 * 60_000 });
    if (!result.ok) return { state: "blocked", code: result.blocker.code, message: result.blocker.message };
    const version = store.listEvents(workspaceId, { type: "portrait.written" }).length + 1;
    const at = new Date().toISOString();
    store.setSetting(workspaceId, "portrait.report", JSON.stringify({ version, at, report: result.output }));
    store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `portrait.written:${version}:${at}`, type: "portrait.written",
      entityId: workspaceId, payload: { version, report: result.output } });
    return { state: "written", version };
  };
}
