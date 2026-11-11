import { tFor, type Locale } from "./i18n";

/**
 * Drill forms (decided 2026-11-10, the owner: 「永远不要给订正类任务；大学生没有人批改作业」). A task's form comes from the goal's first
 * principles and the person's own recorded way of working, never from an identity template (学生 → 订正 / 错题本 / 背诵 / 打卡). The Skills
 * say so; this is the deterministic check behind them: a drill form a model wrote is kept only when the person's own words back it — a
 * fact they confirmed, an answer they gave, a preference they stated, or the words they captured the task in. Anything else is cut out of
 * the text (「做 2 套往年卷并订正」 → 「做 2 套往年卷」), and a step or task that is nothing but the drill is dropped.
 *
 * Course and grade classification (`work-owner.ts` GRADED/LEARN, `milestone-plan.ts`) still reads these words to judge who does a thing
 * and what is graded; it never writes them.
 */
export type DrillForm = "correction" | "recitation" | "checkin" | "grind";

/* i18n-ignore-start: patterns matched against what a model or the person wrote */
const FORMS: Array<{ form: DrillForm; written: RegExp; backed: RegExp }> = [
  { form: "correction", written: /订正|错题|改错|\b(?:mistake|error)s? (?:log|notebook|book|journal)\b/i,
    backed: /订正|错题|改错|\b(?:mistake|error)s? (?:log|notebook|book|journal)\b/i },
  { form: "recitation", written: /背诵|默写|背熟|背下来|背会|\brecit(?:e|ing|ation)\b|\brote\b/i,
    backed: /背诵|默写|背熟|背下|背会|背单词|背公式|靠背|\brecit(?:e|ing|ation)\b|\brote\b|\bmemori[sz]/i },
  { form: "checkin", written: /打卡|\bdaily check-?ins?\b|\bstreaks?\b/i, backed: /打卡|\bcheck-?ins?\b|\bstreaks?\b/i },
  { form: "grind", written: /刷题|题海|\bgrind(?:ing)? (?:through )?(?:problems|questions)\b/i, backed: /刷题|题海|\bgrind/i }
];
/** A backing sentence that turns the form down (「不用错题本」「从不打卡」) backs nothing. */
const NEGATED = /(?:不|没|别|无|讨厌|反感|不想|从不|never|not|don't|no)\s*\S{0,3}$/i;
/** Where a sentence can be cut: the clause joints. 「及时」「以及」 are words, not joints of their own. */
const JOINT = /(并且|并|然后|随后|以及|及(?!时|格)|和|、|，|,|；|;|\s+(?:and|then)\s+)/;
/* i18n-ignore-end */

/** The drill forms a text names. */
export function drillFormsIn(text: string): DrillForm[] {
  return FORMS.filter((item) => item.written.test(text)).map((item) => item.form);
}

/** The drill forms the person's own words back: each backing text is a fact, an answer, a preference or the task's captured words. */
export function backedDrillForms(backing: readonly string[]): Set<DrillForm> {
  const backed = new Set<DrillForm>();
  for (const text of backing) for (const item of FORMS) {
    const pattern = new RegExp(item.backed.source, item.backed.flags.includes("g") ? item.backed.flags : `${item.backed.flags}g`);
    for (const match of text.matchAll(pattern)) if (!NEGATED.test(text.slice(Math.max(0, match.index - 6), match.index))) { backed.add(item.form); break; }
  }
  return backed;
}

const unbacked = (text: string, backed: ReadonlySet<DrillForm>) => drillFormsIn(text).filter((form) => !backed.has(form));

/**
 * The text with every clause that names an unbacked drill form cut out, joints kept between the clauses that stay. "" when nothing
 * else is left (the whole text is the drill); the text itself when it names none.
 */
export function stripDrillForms(text: string, backed: ReadonlySet<DrillForm>): string {
  if (!unbacked(text, backed).length) return text;
  const parts = text.split(JOINT);
  const kept: string[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    const clause = parts[index]!;
    if (!clause.trim() || unbacked(clause, backed).length) continue;
    if (kept.length) kept.push(parts[index - 1] ?? "");
    kept.push(clause);
  }
  return kept.join("").replace(/^[\s，,、；;。.]+|[\s，,、；;。.]+$/g, "");
}

/** A longer text (a rationale) with each sentence naming an unbacked drill form cut, the rest kept as written. */
export function stripDrillSentences(text: string, backed: ReadonlySet<DrillForm>): string {
  if (!unbacked(text, backed).length) return text;
  return (text.match(/[^。！？!?\n]+[。！？!?\n]?/g) ?? []).filter((sentence) => !unbacked(sentence, backed).length).join("").trim();
}

/** Whether a question already asks how the person usually works (so a second one is not added). */
const ASKS_METHOD = /平时怎么|通常怎么|一般怎么|习惯|方法|怎么准备|how (?:do|does) .{0,20}usually|habit|method/i; // i18n-ignore
const EXAM = /考|期中|期末|测验|小测|quiz|exam|midterm|final|test/i; // i18n-ignore
const WRITING = /写|论文|报告|稿|综述|展示|汇报|演讲|presentation|paper|report|essay|draft|talk/i; // i18n-ignore

/**
 * The slots a fact about how the person works is filed under (the interview's 「做事方法」: `method_exam_prep`, `method_learning`,
 * `method_writing`), read by meaning as the checklist reads every slot.
 */
export const METHOD_SLOT = /^method|_method$|approach|technique|study_habit|work_style|workflow/i;

export type MethodQuestion = { id: string; text: string; why: string; options: string[] };
export const METHOD_QUESTION_ID = "q-method";
export const asksMethod = (text: string) => ASKS_METHOD.test(text);

/**
 * The question asked instead of guessing a method: how the person usually does this kind of work. The first option is the neutral one,
 * because a minor task's questions are settled as their first option (the step planner's `assumeAnswers`): an assumed method is never a
 * technique the person did not name.
 */
export function methodQuestion(taskText: string, locale?: Locale): MethodQuestion {
  const t = tFor(locale);
  const neutral = t("没有固定方法，按这次需要定");
  const why = t("做法按本人的习惯来，不套用模板");
  if (EXAM.test(taskText)) return { id: METHOD_QUESTION_ID, text: t("平时怎么准备这类考试？"), why,
    options: [neutral, t("主要做题，再对照答案"), t("主要重读讲义和笔记"), t("写总结或讲给别人听")] };
  if (WRITING.test(taskText)) return { id: METHOD_QUESTION_ID, text: t("平时怎么写这类东西？"), why,
    options: [neutral, t("先列提纲再写"), t("先写草稿再反复改"), t("边查资料边写")] };
  return { id: METHOD_QUESTION_ID, text: t("平时怎么做这类事？"), why,
    options: [neutral, t("先读材料再动手"), t("先动手，遇到问题再查"), t("和别人讨论着做")] };
}

type Screened = { id: string; dependsOn: string[] };
/**
 * Screens a list of steps or tasks: each text field loses the clauses naming an unbacked drill form; one whose title is nothing but the
 * drill is dropped (its dependants take its dependencies), unless it is the last one left. Returns what it changed, so the caller can warn
 * and ask the person how they work instead.
 */
export function screenDrillItems<T extends Screened & { title: string }>(items: readonly T[], backed: ReadonlySet<DrillForm>,
  fields: ReadonlyArray<keyof T>): { items: T[]; stripped: string[]; dropped: string[] } {
  const stripped: string[] = [];
  const dropped: string[] = [];
  let out = items.map((item) => ({ ...item, dependsOn: [...item.dependsOn] }));
  for (const item of [...out]) {
    const title = stripDrillForms(item.title, backed);
    if (title === item.title && !fields.some((field) => typeof item[field] === "string" && stripDrillForms(item[field] as string, backed) !== item[field])) continue;
    if (!title && out.length > 1) {
      out = out.filter((other) => other.id !== item.id);
      for (const other of out) if (other.dependsOn.includes(item.id))
        other.dependsOn = [...new Set([...other.dependsOn.filter((id) => id !== item.id), ...item.dependsOn])];
      dropped.push(item.title);
      continue;
    }
    const original = item.title;
    const target = out.find((other) => other.id === item.id)!;
    if (title) target.title = title;
    for (const field of fields) if (typeof target[field] === "string") (target as Record<keyof T, unknown>)[field] = stripDrillForms(target[field] as string, backed);
    stripped.push(original);
  }
  return { items: out, stripped, dropped };
}
