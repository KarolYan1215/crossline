/**
 * J7, the weekly bug-finding drill (docs/plans/execution-gates-1124.md §四 J7): the events and their payloads, shared by the worker that
 * issues and grades (apps/worker/src/gates/drill.ts) and the web that shows and takes answers (apps/web/lib/drill.ts).
 */
export const DRILL_ISSUED = "drill.issued";
export const DRILL_ANSWERED = "drill.answered";
export const DRILL_GRADED = "drill.graded";
export const DRILL_ISSUE_FAILED = "drill.issue_failed";

export type DrillFile = { name: string; text: string };
export type DrillKeyEntry = { line: number; description: string; failingCheck: string; original: string; replacement: string };
export type DrillIssuedPayload = { week: string; title: string; topic: string; files: DrillFile[]; key: DrillKeyEntry[]; promptVersion: string };
export type DrillAnswer = { line: number; description: string };
export type DrillAnsweredPayload = { week: string; issuedId: string; answers: DrillAnswer[]; fixedFile?: DrillFile };
export type DrillGradedPayload = { week: string; found: number; total: number; falsePositives: number; judgedId: string };
export type DrillMatch = { bug: string; verdict: "found" | "missed"; answer: string; why: string };
