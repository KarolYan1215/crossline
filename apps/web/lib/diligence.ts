import "server-only";
import type { AccessContext } from "@crossline/core";
import { addCapturedTaskWithId, getStore } from "./crossline";

/** What the screen needs from a report: enough to judge it, nothing of the model's working. */
export type DiligenceView = {
  id: string; identityId: string; question: string; status: "queued" | "running" | "done" | "failed"; runAt: string; note?: string;
  findings: Array<{ id: string; claim: string; sourceIds: string[]; confidence: string; staleWhen: string }>;
  proposals: Array<{ id: string; title: string; why: string; kind: string; dueDate: string; findingIds: string[]; status: "pending" | "accepted" | "rejected" }>;
  sources: Array<{ id: string; title: string; publisher: string; finalUrl: string; accessedOn: string }>;
};

/**
 * The stored question is what the researcher was told, rules and all (「只列……facts 里查不到的条件写进 gaps，不要假设……」): the page
 * showed that whole instruction to the person (2026-10-18 walkthrough). Only its first sentence says what was looked for.
 */
export function questionShown(question: string): string {
  const first = question.split("。")[0]!.trim();
  return `${first.replace(/这个人/g, "本人")}。`;
}

export function loadDiligence(ctx: AccessContext): DiligenceView[] {
  return getStore().listDiligenceReports(ctx.workspaceId).map((report) => ({
    id: report.id, identityId: report.scope, question: questionShown(report.question), status: report.status, runAt: report.runAt,
    ...(report.note ? { note: report.note } : {}),
    findings: (report.findings as DiligenceView["findings"]) ?? [],
    proposals: (report.proposals as DiligenceView["proposals"]) ?? [],
    sources: ((report.sources as Array<DiligenceView["sources"][number] & { url?: string }>) ?? [])
      .map(({ id, title, publisher, finalUrl, url, accessedOn }) => ({ id, title, publisher, finalUrl: finalUrl ?? url ?? "", accessedOn }))
  }));
}

/**
 * Records the person's answer to one proposal. An answer can be changed, and `pending` takes it back. Accepting a 「任务」 also writes it
 * down as a capture, which the analysis turns into a task like anything typed into the box: before, 「采纳」 only fed the next milestone
 * design and the person saw nothing happen (2026-10-18 walkthrough). Milestone and watch proposals stay inputs to the milestone design.
 */
export function decideDiligenceProposal(ctx: AccessContext, reportId: string, proposalId: string, decision: "accepted" | "rejected" | "pending"):
  { ok: true; captured: boolean } | { ok: false; code: string } {
  const store = getStore();
  const report = store.listDiligenceReports(ctx.workspaceId).find((item) => item.id === reportId);
  const proposals = (report?.proposals as DiligenceView["proposals"] | undefined) ?? [];
  const proposal = proposals.find((item) => item.id === proposalId);
  if (!report || !proposal) return { ok: false, code: "DILIGENCE_PROPOSAL_NOT_FOUND" };
  store.saveDiligenceReport({ ...report, proposals: proposals.map((item) => item.id === proposalId ? { ...item, status: decision } : item) });
  store.appendEvent({
    ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `diligence:decided:${reportId}:${proposalId}:${decision}:${Date.now()}`,
    type: "diligence.decided", entityId: reportId, payload: { proposalId, decision }
  });
  const captureId = `diligence-${reportId}-${proposalId}`;
  if (decision !== "accepted" || proposal.kind !== "task" || store.listCaptures(ctx.workspaceId).some((item) => item.id === captureId)) {
    return { ok: true, captured: false };
  }
  const context = [proposal.why, proposal.dueDate ? `截止：${proposal.dueDate}` : "", `主线：${report.scope}`, "来自调研建议"].filter(Boolean).join("\n");
  addCapturedTaskWithId(ctx, { title: proposal.title.slice(0, 240), context: context.slice(0, 500) }, captureId, captureId);
  return { ok: true, captured: true };
}
