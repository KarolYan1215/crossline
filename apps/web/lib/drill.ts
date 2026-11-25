import "server-only";
import {
  DRILL_ANSWERED, DRILL_GRADED, DRILL_ISSUED, GATE_JUDGED, type AccessContext, type DrillAnswer as Answer, type DrillAnsweredPayload as AnsweredPayload,
  type DrillFile, type DrillGradedPayload as GradedPayload, type DrillIssuedPayload as IssuedPayload, type DrillMatch as Match, type GateJudgedPayload
} from "@crossline/core";
import { getStore } from "./crossline";

/**
 * J7, the weekly bug-finding drill, the web's half (docs/plans/execution-gates-1124.md §四 J7). The worker issues one simulated exercise
 * a week (`drill.issued`, apps/worker/src/gates/drill.ts) and grades answers (`gate.judged` gate `drill`, then `drill.graded`); here the
 * person reads the exercise, answers once, and sees the trend. The answer key never leaves the server before the week is graded.
 */
const MAX_ANSWERS = 20;
const MAX_DESCRIPTION = 400;
const MAX_FILE_CHARS = 200_000;


export type DrillView = {
  current?: {
    week: string; title: string; issuedAt: string; bugCount: number; files: DrillFile[];
    answered?: { at: string; answers: Answer[]; fixedFileName?: string };
    /** Only once graded: the key itself, bug by bug, with whether the person found it. */
    graded?: { at: string; found: number; total: number; falsePositives: number; bugs: Array<{ line: number; description: string; verdict: "found" | "missed"; why: string }> };
  };
  history: Array<{ week: string; title: string; total: number; found: number | null }>;
};

export function loadDrill(ctx: AccessContext): DrillView {
  const store = getStore();
  const issued = store.listEvents(ctx.workspaceId, { type: DRILL_ISSUED }).sort((a, b) => b.entityId.localeCompare(a.entityId));
  const answered = new Map(store.listEvents(ctx.workspaceId, { type: DRILL_ANSWERED }).map((event) => [event.entityId, event]));
  const graded = new Map(store.listEvents(ctx.workspaceId, { type: DRILL_GRADED }).map((event) => [(event.payload as GradedPayload).week, event]));
  const history = issued.map((event) => {
    const drill = event.payload as IssuedPayload;
    const grade = graded.get(drill.week)?.payload as GradedPayload | undefined;
    return { week: drill.week, title: drill.title, total: drill.key.length, found: grade ? grade.found : null };
  });
  const latest = issued[0];
  if (!latest) return { history };
  const drill = latest.payload as IssuedPayload;
  const answer = answered.get(drill.week);
  const grade = graded.get(drill.week);
  const current: NonNullable<DrillView["current"]> = { week: drill.week, title: drill.title, issuedAt: latest.createdAt, bugCount: drill.key.length,
    files: drill.files.map((file) => ({ name: file.name, text: file.text })) };
  if (answer) {
    const payload = answer.payload as AnsweredPayload;
    current.answered = { at: answer.createdAt, answers: payload.answers, ...(payload.fixedFile ? { fixedFileName: payload.fixedFile.name } : {}) };
  }
  if (grade) {
    const summary = grade.payload as GradedPayload;
    const judged = store.listEvents(ctx.workspaceId, { type: GATE_JUDGED }).find((event) => event.eventId === summary.judgedId);
    const matches = ((judged?.payload as GateJudgedPayload | undefined)?.output.detail as { matches?: Match[] } | undefined)?.matches ?? [];
    const byBug = new Map(matches.map((match) => [match.bug, match]));
    current.graded = { at: grade.createdAt, found: summary.found, total: summary.total, falsePositives: summary.falsePositives,
      bugs: drill.key.map((entry, index) => {
        const match = byBug.get(`B${index + 1}`);
        return { line: entry.line, description: entry.description, verdict: match?.verdict ?? "missed", why: match?.why ?? "" };
      }) };
  }
  return { current, history };
}

export type AnswerDrillInput = { week: unknown; answers: unknown; fixedFile?: unknown };

/** The person's answer to a week's drill, once. Lines and descriptions are theirs; the worker grades them against the key. */
export function answerDrill(ctx: AccessContext, input: AnswerDrillInput): { ok: true } | { ok: false; code: string } {
  const store = getStore();
  const week = typeof input.week === "string" ? input.week : "";
  const issued = week ? store.listEvents(ctx.workspaceId, { type: DRILL_ISSUED, entityId: week })[0] : undefined;
  if (!issued) return { ok: false, code: "DRILL_NOT_FOUND" };
  if (store.listEvents(ctx.workspaceId, { type: DRILL_ANSWERED, entityId: week }).length) return { ok: false, code: "DRILL_ALREADY_ANSWERED" };
  if (!Array.isArray(input.answers) || !input.answers.length || input.answers.length > MAX_ANSWERS) return { ok: false, code: "DRILL_ANSWER_INVALID" };
  const answers: Answer[] = [];
  for (const raw of input.answers as Array<Record<string, unknown> | null>) {
    const line = Number(raw?.line);
    const description = typeof raw?.description === "string" ? raw.description.trim() : "";
    if (!Number.isInteger(line) || line < 1 || line > 100_000 || !description || description.length > MAX_DESCRIPTION) return { ok: false, code: "DRILL_ANSWER_INVALID" };
    answers.push({ line, description });
  }
  let fixedFile: DrillFile | undefined;
  if (input.fixedFile !== undefined && input.fixedFile !== null) {
    const file = input.fixedFile as Record<string, unknown>;
    const name = typeof file.name === "string" ? file.name.split(/[\\/]/).at(-1)!.slice(0, 120) : "";
    if (!name || typeof file.text !== "string" || !file.text.trim() || file.text.length > MAX_FILE_CHARS) return { ok: false, code: "DRILL_FILE_INVALID" };
    fixedFile = { name, text: file.text };
  }
  const payload: AnsweredPayload = { week, issuedId: issued.eventId, answers, ...(fixedFile ? { fixedFile } : {}) };
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, type: DRILL_ANSWERED, entityId: week, idempotencyKey: `${DRILL_ANSWERED}:${week}`, payload });
  return { ok: true };
}
