import "server-only";
import type { AccessContext } from "@crossline/core";
import { getStore } from "./crossline";

/** What the screen needs from a report: enough to judge it, nothing of the model's working. */
export type DiligenceView = {
  id: string; identityId: string; question: string; status: "queued" | "running" | "done" | "failed"; runAt: string; note?: string;
  findings: Array<{ id: string; claim: string; sourceIds: string[]; confidence: string; staleWhen: string }>;
  proposals: Array<{ id: string; title: string; why: string; kind: string; dueDate: string; findingIds: string[]; status: "pending" | "accepted" | "rejected" }>;
  sources: Array<{ id: string; title: string; publisher: string; finalUrl: string; accessedOn: string }>;
};

export function loadDiligence(ctx: AccessContext): DiligenceView[] {
  return getStore().listDiligenceReports(ctx.workspaceId).map((report) => ({
    id: report.id, identityId: report.scope, question: report.question, status: report.status, runAt: report.runAt,
    ...(report.note ? { note: report.note } : {}),
    findings: (report.findings as DiligenceView["findings"]) ?? [],
    proposals: (report.proposals as DiligenceView["proposals"]) ?? [],
    sources: ((report.sources as Array<DiligenceView["sources"][number] & { url?: string }>) ?? [])
      .map(({ id, title, publisher, finalUrl, url, accessedOn }) => ({ id, title, publisher, finalUrl: finalUrl ?? url ?? "", accessedOn }))
  }));
}

/** Records the person's answer to one proposal. An answer can be changed, and `pending` takes it back. */
export function decideDiligenceProposal(ctx: AccessContext, reportId: string, proposalId: string, decision: "accepted" | "rejected" | "pending"):
  { ok: true } | { ok: false; code: string } {
  const store = getStore();
  const report = store.listDiligenceReports(ctx.workspaceId).find((item) => item.id === reportId);
  const proposals = (report?.proposals as Array<{ id: string; status: string }> | undefined) ?? [];
  if (!report || !proposals.some((proposal) => proposal.id === proposalId)) return { ok: false, code: "DILIGENCE_PROPOSAL_NOT_FOUND" };
  store.saveDiligenceReport({ ...report, proposals: proposals.map((proposal) => proposal.id === proposalId ? { ...proposal, status: decision } : proposal) });
  store.appendEvent({
    ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `diligence:decided:${reportId}:${proposalId}:${decision}:${Date.now()}`,
    type: "diligence.decided", entityId: reportId, payload: { proposalId, decision }
  });
  return { ok: true };
}
