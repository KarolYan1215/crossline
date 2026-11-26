import { judgedItems, type ChecklistItem } from "./interview-checklist";
import type { LedgerQuestion } from "./question-ledger";

/**
 * The interview's ledger snapshot (2026-11-25, the owner: 「通过账本作为可信的、不会被上下文压缩的外部记忆，来确保既没有重复追问，也不会
 * 漏掉该问的」). Rendered from the ledger at the start of every round and put at the head of the round's message, after the thread's fixed
 * prefix (docs/token-economy.md: what changes goes last): the checklist with the model's last verdict per item, every question asked so
 * far with its meaning and the person's answer, and the days the person gave. The thread may be compacted; the snapshot is not, so the
 * model judges against it, not against what it remembers.
 *
 * Model-facing only, never shown to the person.
 */
export type SnapshotQuestion = LedgerQuestion & { gist?: string };
export type SnapshotInput = {
  /** The round about to run (the person's replies so far). */
  round: number;
  items: readonly ChecklistItem[];
  questions: readonly SnapshotQuestion[];
  /** The days the person wrote, by the reply they wrote them in (`datesWritten`). */
  datesSaid: ReadonlyArray<{ ref: string; dates: string[] }>;
  /** Where a disclosure sits and what the person agreed to (the round's `disclosure` note), when there is one. */
  disclosure?: string | undefined;
};

/** Answered questions shown with their answers; older ones by their meaning alone. */
export const SNAPSHOT_ANSWERS_SHOWN = 30;
/** Questions listed at all, newest kept. */
export const SNAPSHOT_QUESTIONS_SHOWN = 120;

const statusWord: Record<string, string> = { pending: "待问", open: "未答", answered: "已答", assumed: "按假设", dropped: "不再问" }; // i18n-ignore: model-facing
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/* i18n-ignore-start: the snapshot is the model's input */
export function renderInterviewSnapshot(input: SnapshotInput): string {
  const lines: string[] = [`〔账本快照 · 第 ${input.round} 轮开始前 · 从账本生成，以它为准，不靠上下文记忆〕`];

  const judged = judgedItems(input.items);
  const start = input.items.filter((item) => item.start && !item.done);
  lines.push("", "一、清单。逐项对照下面的已问题目、本人的回答和材料，在 mark_round 的 checklist 里给 status（answered / partial / missing / not_applicable）"
    + "和依据（basis：ref 写 reply-N 或 src-N，quote 逐字抄一段）；上次已判 answered、这一轮没有新情况的可以不再给。缺的项在合适的一轮问到，不漏。");
  if (start.length) lines.push(`- 开始使用还缺：${start.map((item) => item.label).join("；")}`);
  for (const item of judged) {
    const verdict = item.verdict;
    const said = verdict ? `${verdict.status}${verdict.basis.length ? ` ← ${verdict.basis.map((basis) => `${basis.ref}「${clip(basis.quote, 30)}」`).join(" ")}` : ""}${verdict.note ? `（${clip(verdict.note, 60)}）` : ""}`
      : item.done ? "已由账本结构满足" : "未判";
    lines.push(`- ${item.id}｜${item.label}${item.deferred ? "（可留到排任务时再问）" : ""}｜${said}${!item.done && item.detail && !verdict?.note ? `｜缺：${clip(item.detail, 60)}` : ""}`);
  }
  if (!judged.length && !start.length) lines.push("- （没有要判定的项）");

  const shown = input.questions.filter((question) => question.status !== "dropped").slice(-SNAPSHOT_QUESTIONS_SHOWN);
  const answered = shown.filter((question) => question.status === "answered" || question.status === "assumed");
  const withAnswer = new Set(answered.slice(-SNAPSHOT_ANSWERS_SHOWN).map((question) => question.id));
  lines.push("", "二、已问过的题。出新题（回复里的主问题、问题卡）前逐条对照意思，不看字面：意思相同的不再问；答了一部分只问缺的，并说出已有的；"
    + "在 mark_round 的 asked（回复里的问题）或问题卡上写 gist（这道题问的是什么，几个字）和 repeats（意思相同的那道题的编号，没有写 0），"
    + "接着某个回答往深问时 followUp 设 true。");
  if (!shown.length) lines.push("- （还没有问过题）");
  for (const question of shown) {
    const meaning = question.gist?.trim() ? `${question.gist.trim()}｜原题：${clip(question.text, 60)}` : clip(question.text, 80);
    const answer = withAnswer.has(question.id) && question.answer ? ` → 「${clip(question.answer, 100)}」` : "";
    const app = question.key.startsWith("gap:") ? "（应用的待问题，用 ask_app_question 问）" : "";
    lines.push(`- #${question.id} ${statusWord[question.status] ?? question.status}｜${meaning}${app}${answer}`);
  }

  const dated = input.datesSaid.filter((item) => item.dates.length);
  lines.push("", "三、本人说过的日期。回复里写的日子只能是这里的、文件里的或调研查到的；本人没给的日子不写，要定就问本人想放在哪天。");
  lines.push(dated.length ? dated.map((item) => `- ${item.ref}：${item.dates.join("、")}`).join("\n") : "- （本人还没写过具体日期）");

  if (input.disclosure) lines.push("", `四、${input.disclosure}`);
  return lines.join("\n");
}
/* i18n-ignore-end */
