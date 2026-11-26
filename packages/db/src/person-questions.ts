import { randomUUID } from "node:crypto";
import { personAnswerSlot, questionSimilarity, SAME_QUESTION, type LedgerQuestion, type PersonQuestionAsked, type PersonQuestionRef } from "@crossline/core";
import type { CrosslineStore } from "./index";

/**
 * The ledger side of `ask_person` (docs/plans/harness-1125.md 「主动提问」). A question is one `person.question.asked` event (its reader:
 * the 待确认 card `skill_question` in `apps/web/lib/asks.ts`, and `ask-tool.ts` looking for an open one to join) plus a row in the question
 * ledger (`ask:pq:<id>`), which carries its status and answer like every other question the person was asked. Another run asking the same
 * question while it is open writes one more event on the same id (`join`), so its answer reruns that run too: one card, several waiters.
 */
export const PERSON_QUESTION_EVENT = "person.question.asked";
export const personQuestionKey = (id: string) => `ask:pq:${id}`;

export type PersonQuestionAsker = { skill: string; ref: PersonQuestionRef; blocking: boolean; askedAt: string };
export type PersonQuestionRow = PersonQuestionAsked & { askedAt: string; askers: PersonQuestionAsker[]; status: LedgerQuestion["status"]; answer: string };

/** Records a new question (open on the ledger) and returns its id. */
export function recordPersonQuestion(store: CrosslineStore, workspaceId: string, asked: Omit<PersonQuestionAsked, "id">, at: string): string {
  const ownerId = store.getWorkspaceOwnerId(workspaceId) ?? "";
  const id = `pq-${randomUUID().slice(0, 8)}`;
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: `person:question:${id}`, type: PERSON_QUESTION_EVENT, entityId: id, payload: { ...asked, id } });
  store.recordQuestion(workspaceId, { kind: "ask", key: personQuestionKey(id), text: asked.question, options: asked.options,
    identityId: asked.identityId, projectId: asked.projectId, status: "open", at });
  return id;
}

/** Another run waits on an open question: its blocking answer reruns that run as well. Once per run target. */
export function joinPersonQuestion(store: CrosslineStore, workspaceId: string, id: string, asker: Omit<PersonQuestionAsker, "askedAt">): void {
  const ownerId = store.getWorkspaceOwnerId(workspaceId) ?? "";
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: `person:question:${id}:join:${asker.ref.kind}:${asker.ref.id}`, type: PERSON_QUESTION_EVENT,
    entityId: id, payload: { join: true, skill: asker.skill, ref: asker.ref, blocking: asker.blocking } });
}

/** Every question asked with `ask_person`, with who waits on it and its status on the question ledger. */
export function personQuestions(store: CrosslineStore, workspaceId: string): PersonQuestionRow[] {
  const rows = new Map<string, PersonQuestionRow>();
  for (const event of store.listEvents(workspaceId, { type: PERSON_QUESTION_EVENT })) {
    const payload = event.payload as Partial<PersonQuestionAsked> & { join?: boolean; skill?: string; ref?: PersonQuestionRef; blocking?: boolean };
    const asker = { skill: payload.skill ?? "", ref: payload.ref ?? { kind: "task" as const, id: "" }, blocking: payload.blocking === true, askedAt: event.createdAt };
    const row = rows.get(event.entityId);
    if (row) { row.askers.push(asker); continue; }
    if (payload.join || !payload.question) continue;
    const ledger = store.questionByKey(workspaceId, personQuestionKey(event.entityId));
    rows.set(event.entityId, { ...(payload as PersonQuestionAsked), id: event.entityId, askedAt: event.createdAt, askers: [asker],
      status: ledger?.status ?? "open", answer: ledger?.answer ?? "" });
  }
  return [...rows.values()];
}

/** Questions still waiting for the person: not answered, not settled by the assumption. */
export const openPersonQuestions = (store: CrosslineStore, workspaceId: string) =>
  personQuestions(store, workspaceId).filter((row) => row.status !== "answered" && row.status !== "assumed");

/**
 * A question the person already answered that this one repeats, from the whole question ledger (the interview's, every 待确认 card's,
 * the step plans' and these): its answer is given back to the run instead of asking again. Scoped to the same project when both name one.
 */
export function answeredLike(store: CrosslineStore, workspaceId: string, text: string, scope: { projectId?: string } = {}): LedgerQuestion | undefined {
  return store.listQuestions(workspaceId, { statuses: ["answered", "assumed"] })
    .filter((question) => question.answer.trim() && (!scope.projectId || !question.projectId || question.projectId === scope.projectId))
    .map((question) => ({ question, score: questionSimilarity(text, question.text) }))
    .filter((item) => item.score >= SAME_QUESTION).sort((a, b) => b.score - a.score)[0]?.question;
}

/** An open question this one repeats (same project when both name one), to join rather than ask twice. */
export function openLike(store: CrosslineStore, workspaceId: string, text: string, scope: { projectId?: string } = {}): PersonQuestionRow | undefined {
  return openPersonQuestions(store, workspaceId)
    .filter((row) => !scope.projectId || !row.projectId || row.projectId === scope.projectId)
    .map((row) => ({ row, score: questionSimilarity(text, row.question) }))
    .filter((item) => item.score >= SAME_QUESTION).sort((a, b) => b.score - a.score)[0]?.row;
}

/**
 * The person's answer (or 「按假设」): kept as a confirmed fact whose source is the person's answer (`sourceRef` `ask:pq:<id>`), and on the
 * question ledger. Returns the runs to do again: every blocking asker's target, once each — none when the person kept the assumption,
 * since the runs already went on with it.
 */
export function settlePersonQuestion(store: CrosslineStore, workspaceId: string, id: string, answer: string, how: "answered" | "assumed", at: string):
  { ok: true; rerun: PersonQuestionRef[] } | { ok: false; code: string } {
  const row = personQuestions(store, workspaceId).find((item) => item.id === id);
  if (!row) return { ok: false, code: "PERSON_QUESTION_GONE" };
  const text = answer.trim().slice(0, 1000);
  if (!text) return { ok: false, code: "PERSON_ANSWER_EMPTY" };
  const ledger = store.questionByKey(workspaceId, personQuestionKey(id));
  store.atomically(() => {
    store.upsertProfileFact({ workspaceId, identityId: row.identityId || "person", projectId: row.projectId, slot: personAnswerSlot(row.question),
      value: `【${row.question}】${text}`, status: "confirmed", sourceRef: personQuestionKey(id), sourceQuote: text, updatedAt: at });
    const number = ledger?.id ?? store.recordQuestion(workspaceId, { kind: "ask", key: personQuestionKey(id), text: row.question, options: row.options,
      identityId: row.identityId, projectId: row.projectId, status: "open", at });
    store.answerQuestion(workspaceId, number, { text, status: how, at });
  });
  if (how === "assumed") return { ok: true, rerun: [] };
  const seen = new Set<string>();
  return { ok: true, rerun: row.askers.filter((asker) => asker.blocking && asker.ref.id).map((asker) => asker.ref)
    .filter((ref) => !seen.has(`${ref.kind}:${ref.id}`) && Boolean(seen.add(`${ref.kind}:${ref.id}`))) };
}
