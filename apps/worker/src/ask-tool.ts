import type { SkillTools } from "@crossline/codex";
import { ASK_PERSON_INSTRUCTIONS, ASK_PERSON_TOOL, PERSON_QUESTIONS_PER_RUN, pushesPersonQuestion, readPersonQuestion, type PersonQuestionRef } from "@crossline/core";
import { answeredLike, joinPersonQuestion, openLike, recordPersonQuestion, type CrosslineStore } from "@crossline/db";
import { tOfWorkspace } from "./locale";
import { sayToPerson } from "./workflow-smith";

/**
 * `ask_person` for a background Skill (docs/plans/harness-1125.md 「主动提问」, the owner's rule of 2026-11-25): the model asks the person
 * what only they know and goes on with its stated assumption. What code decides here, before anything reaches the person:
 * - a question the question ledger already holds an answer to is answered from it (the run gets the answer, the person is not asked);
 * - one already open (asked by this run or another) is joined, not asked twice: one card, and a blocking answer reruns every waiter;
 * - at most `PERSON_QUESTIONS_PER_RUN` new questions a run;
 * - a run that read someone else's words (`untrusted`) may not put a link before the person, and its card says where it came from.
 * Pushed only when blocking and what it bears on is due within 48 hours (`pushesPersonQuestion`, push kind `person_question`); every other
 * question only waits on 待确认 (its home, ask kind `skill_question`).
 */
export type AskToolContext = {
  store: CrosslineStore; workspaceId: string;
  /** The Skill asking, recorded with the question. */
  skill: string;
  /** What a blocking answer reruns. */
  ref: PersonQuestionRef;
  identityId: string; projectId: string;
  /** The day what the run serves is due (`YYYY-MM-DD`), "" when nothing is: decides urgency on 待确认 and whether it may push. */
  dueBy: string;
  /** Whether the run has read untrusted content (a web page, a mail) by the time it asks; read at each call. */
  untrusted?: () => boolean;
  /** What the push names (a task's or milestone's title). */
  title?: string;
  now?: () => Date;
  perRun?: number;
};

export type AskToolOutcome = { status: "answered" | "joined" | "asked"; id?: string; question: string };

/** The `ask_person` tool for one run (made fresh per run, so the cap is per run), with what it did. */
export function createAskTool(context: AskToolContext): SkillTools & { outcomes: () => AskToolOutcome[] } {
  const { store, workspaceId } = context;
  const now = () => context.now?.() ?? new Date();
  const limit = context.perRun ?? PERSON_QUESTIONS_PER_RUN;
  const outcomes: AskToolOutcome[] = [];
  return {
    outcomes: () => [...outcomes],
    specs: [ASK_PERSON_TOOL],
    // The tool's answers and refusals are read by the model, not the person.
    /* i18n-ignore-start */
    call(name, args) {
      if (name !== ASK_PERSON_TOOL.name) throw new Error(`没有名为 ${name} 的工具`);
      const untrusted = context.untrusted?.() ?? false;
      const read = readPersonQuestion(args, { untrusted });
      if (!read.ok) throw new Error(read.reason);
      const asked = read.question;
      const scope = { projectId: context.projectId };
      const answered = answeredLike(store, workspaceId, asked.question, scope);
      if (answered) {
        outcomes.push({ status: "answered", question: asked.question });
        return JSON.stringify({ status: "answered", question: answered.text, answer: answered.answer,
          note: "本人已经回答过这个问题：按这个答案继续，不要再问。" });
      }
      const open = openLike(store, workspaceId, asked.question, scope);
      if (open) {
        if (!open.askers.some((asker) => asker.ref.kind === context.ref.kind && asker.ref.id === context.ref.id))
          joinPersonQuestion(store, workspaceId, open.id, { skill: context.skill, ref: context.ref, blocking: asked.blocking });
        outcomes.push({ status: "joined", id: open.id, question: asked.question });
        return JSON.stringify({ status: "already_asked", question: open.question,
          note: "这个问题已经在等本人回答：先按 assumption 完成这次输出，不要再问。" });
      }
      if (outcomes.filter((item) => item.status === "asked").length >= limit)
        throw new Error(`本次运行已向本人提了 ${limit} 个问题，不能再问：按 assumption 继续，并在输出里写明所作的假设。`);
      const at = now();
      const record = { ...asked, skill: context.skill, ref: context.ref, identityId: context.identityId, projectId: context.projectId,
        dueBy: context.dueBy, origin: untrusted ? "untrusted" as const : "own" as const };
      const id = recordPersonQuestion(store, workspaceId, record, at.toISOString());
      outcomes.push({ status: "asked", id, question: asked.question });
      /* i18n-ignore-end */
      if (pushesPersonQuestion(record, at)) {
        const t = tOfWorkspace(store, workspaceId);
        sayToPerson(store, workspaceId, t("「{{title}}」需要本人回答：{{question}}（未回答前按「{{assumption}}」做）", {
          title: (context.title ?? "").slice(0, 40), question: asked.question.slice(0, 160), assumption: asked.assumption.slice(0, 60) }),
          "person_question", id, [{ label: t("去回答"), href: "/approvals#asks" }], at);
      }
      // i18n-ignore: an answer to the model
      return JSON.stringify({ status: "asked", id, note: asked.blocking ? "已记下。先按 assumption 完成这次输出；本人回答后这次工作会按答案重做。" : "已记下。按 assumption 继续。" });
    }
  };
}

/**
 * A run's tools with `ask_person` added (the specs concatenated; a name already in `tools` keeps its own answer). Stacks with the other
 * tool sets callers add the same way (`web_research`, the lookups): nothing here rebuilds how a run's tools are put together.
 */
export function withAskTool(tools: SkillTools | undefined, context: AskToolContext | SkillTools): SkillTools {
  const ask = "specs" in context ? context : createAskTool(context);
  const own = tools?.specs ?? [];
  return {
    specs: [...own, ...ask.specs.filter((spec) => !own.some((mine) => mine.name === spec.name))],
    call: (name, args) => own.some((spec) => spec.name === name) ? tools!.call(name, args) : ask.call(name, args)
  };
}

export { ASK_PERSON_INSTRUCTIONS };
