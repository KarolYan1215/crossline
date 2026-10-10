import type { ChecklistAnswer } from "@crossline/core";
import type { EvidenceClaimInput } from "@crossline/db";

/**
 * The shape checks a completion's body goes through, shared by the online route and the offline replay. The replay had its own copy
 * that read evidence only, so a completion queued offline lost the minutes the person tapped and the checklist they answered.
 */
const EVIDENCE_KINDS = ["file", "link", "record", "telemetry"];

export function readEvidence(value: unknown): EvidenceClaimInput[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) return null;
  const claims: EvidenceClaimInput[] = [];
  for (const entry of value) {
    const claim = entry as Record<string, unknown>;
    const uri = String(claim?.uri ?? "").trim();
    const description = String(claim?.description ?? "").trim();
    if (!EVIDENCE_KINDS.includes(String(claim?.kind)) || !uri || uri.length > 500 || !description || description.length > 500) return null;
    claims.push({ kind: claim.kind as EvidenceClaimInput["kind"], uri, description });
  }
  return claims;
}

/** The pre-generated checklist answers: an id matched against the order's `evidenceChecklist` at gate time, and a bounded answer. */
export function readChecklistAnswers(value: unknown): ChecklistAnswer[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) return null;
  const answers: ChecklistAnswer[] = [];
  for (const entry of value) {
    const answer = entry as Record<string, unknown>;
    const questionId = String(answer?.questionId ?? "").trim();
    const text = String(answer?.answer ?? "").trim();
    if (!questionId || questionId.length > 200 || !text || text.length > 2000) return null;
    answers.push({ questionId, answer: text });
  }
  return answers;
}

/** How long the person says it took (one tap, or the screen record's suggestion they confirmed); anything else is no report. */
export function readReport(body: Record<string, unknown>): { minutes: number; source: "one_tap" | "activity" } | undefined {
  const minutes = Number(body.reportedMinutes);
  return Number.isInteger(minutes) && minutes > 0 && minutes <= 1440
    ? { minutes, source: body.reportedSource === "activity" ? "activity" : "one_tap" } : undefined;
}
