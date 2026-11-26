import "server-only";
import { urgencyFor, type AccessContext, type Ask, type AskOption, type PersonQuestionRef, type Translate } from "@crossline/core";
import { personQuestions, settlePersonQuestion, type PersonQuestionRow } from "@crossline/db";
import { getStore, retryMaterialPreparation } from "./crossline";
import { requestAutoBackplan } from "./approvals";
import { requestStepReplan } from "./steps";
import { requestTutorial } from "./tutorial";

/**
 * The 待确认 card of a question a Skill put to the person with `ask_person` (ask kind `skill_question`; docs/plans/harness-1125.md
 * 「主动提问」). Built on read from `person.question.asked`, never stored; gone once answered or once nothing it bears on is still open.
 * A question that blocks nothing and is not due within the week waits for the weekly review (`inReview`), like a step plan's.
 */
const CLOSED_ORDER = new Set(["accepted", "archived"]);

function liveTargets(store: ReturnType<typeof getStore>, workspaceId: string, row: PersonQuestionRow): PersonQuestionRef[] {
  const orders = new Map(store.listWorkOrders(workspaceId).map((order) => [order.id, order.state]));
  const approved = new Set(store.listMilestones(workspaceId).filter((milestone) => milestone.status === "approved").map((milestone) => milestone.id));
  return row.askers.map((asker) => asker.ref).filter((ref) => ref.kind === "milestone" ? approved.has(ref.id)
    : orders.has(ref.id) && !CLOSED_ORDER.has(orders.get(ref.id)!));
}

export function skillQuestionAsks({ ctx, today, t }: { ctx: AccessContext; today: string; t: Translate }): Ask[] {
  const store = getStore();
  return personQuestions(store, ctx.workspaceId).filter((row) => row.status !== "answered" && row.status !== "assumed").flatMap((row): Ask[] => {
    const targets = liveTargets(store, ctx.workspaceId, row);
    if (!targets.length) return [];
    const blocking = row.askers.some((asker) => asker.blocking);
    const due = /^\d{4}-\d{2}-\d{2}$/.test(row.dueBy) ? row.dueBy : undefined;
    const urgency = urgencyFor(due, today);
    const first = targets[0]!;
    const untrusted = row.origin === "untrusted";
    const assume = t("就按「{{assumption}}」", { assumption: row.assumption });
    const options: AskOption[] = row.answerType === "choice"
      ? [...row.options.map((option, index) => ({ id: `o${index}`, label: option, ...(option === row.assumption ? { recommended: true } : {}) })),
        ...(row.options.includes(row.assumption) ? [] : [{ id: "assume", label: assume, recommended: true }])]
      : row.answerType === "date"
        ? [{ id: "answer", label: t("填日期"), fields: [{ id: "answer", label: t("日期"), kind: "date" as const, required: true }] }, { id: "assume", label: assume }]
        : row.answerType === "long_text"
          ? [{ id: "answer", label: t("写回答"), fields: [{ id: "answer", label: t("回答"), kind: "longtext" as const, required: true }] }, { id: "assume", label: assume }]
          : [{ id: "assume", label: assume }];
    return [{
      id: `pq:${row.id}`, kind: "skill_question", entityId: row.id, ...(row.identityId && row.identityId !== "person" ? { line: row.identityId } : {}),
      urgency, ...(due ? { dueDay: due } : {}), raisedAt: row.askedAt, fingerprint: `${row.id}:${row.askers.length}`,
      important: blocking, ...(!blocking && urgency === "later" ? { inReview: true as const } : {}),
      preview: first.kind === "milestone" ? { kind: "milestones", href: `/milestones?open=${encodeURIComponent(first.id)}`, label: t("看里程碑") }
        : { kind: "task", href: `/workbench/${encodeURIComponent(first.id)}`, label: t("看任务") },
      // Where it came from, said on the card: a run that read a web page or a mail asked it (it carries no link; ask-tool.ts refuses one).
      ...(untrusted ? { tags: [{ kind: "type" as const, label: t("来自读过外部内容的运行") }] } : {}),
      ...(row.answerType === "text" || row.answerType === "choice" ? { freeText: { placeholder: t("例如：{{assumption}}，或用自己的话说", { assumption: row.assumption }) } } : {}),
      title: row.question,
      why: [t("{{why}}。", { why: row.why.replace(/[。.]$/, "") }),
        untrusted ? t("这个问题由读过网页或邮件的运行提出，回答前先核对它问的是不是本人的事。") : "",
        t("回答前按「{{assumption}}」做。", { assumption: row.assumption }),
        blocking ? t("回答后，相关工作会按答案重做。") : t("回答会记为本人确认的事实，以后不再问。")].filter(Boolean).join(""),
      options
    }];
  });
}

/** The answer: kept as the person's own fact, and every blocking run that asked it done again with it. */
export function answerSkillQuestion(ctx: AccessContext, ask: Ask, choice: { optionIds: string[]; note: string }, values: Record<string, string>, now: Date):
  { ok: true } | { ok: false; code: string } {
  const store = getStore();
  const row = personQuestions(store, ctx.workspaceId).find((item) => item.id === ask.entityId);
  if (!row) return { ok: false, code: "PERSON_QUESTION_GONE" };
  const optionId = choice.optionIds[0] ?? "";
  const picked = ask.options.find((option) => option.id === optionId);
  const assumed = optionId === "assume" && !choice.note;
  const answer = assumed ? row.assumption
    : [optionId.startsWith("o") ? picked?.label ?? "" : "", values.answer ?? "", choice.note].map((text) => text.trim()).filter(Boolean).join("；");
  const settled = settlePersonQuestion(store, ctx.workspaceId, row.id, answer, assumed ? "assumed" : "answered", now.toISOString());
  if (!settled.ok) return settled;
  // i18n-ignore: feedback for the step planner (model context)
  const feedback = `本人回答了「${row.question}」：${answer}。按此重做。`;
  for (const ref of settled.rerun) {
    if (ref.kind === "task") requestStepReplan(ctx, ref.id, feedback);
    else if (ref.kind === "tutorial") requestTutorial(ctx, ref.id);
    else if (ref.kind === "materials") retryMaterialPreparation(ctx, ref.id);
    else {
      store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `goal:backplan:rerun:${ref.id}:pq:${row.id}`,
        type: "goal.backplan_rerun_requested", entityId: ref.id, payload: { questionId: row.id } });
      requestAutoBackplan(ctx);
    }
  }
  return { ok: true };
}
