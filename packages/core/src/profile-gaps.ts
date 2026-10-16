import type { TurnQuestion } from "./onboarding-turn-schema";
import { courseCodeOf } from "./task-title";
import { tFor, type Locale } from "./i18n";

/**
 * What the profile still has to learn from the person before milestones are designed from it.
 *
 * These are computed from the ledger, not left to the interview model to remember: a real run finished an interview with three of four
 * lines resting on guesses the model had made itself. A gap that blocks stops 「ready for milestones」, and the question that closes it is
 * built in code with the options the person picks from, so it is asked whether or not the model thought of it.
 *
 * A course's target grade is deliberately not a gap: the model proposes one from the person's long-term goals (and says why), the person
 * changes it in one click on the Milestones page, and the numbers follow. Asking up front made a list of questions before anything existed
 * to react to.
 */
export type ProfileGapInput = {
  identities: Array<{ id: string; label: string }>;
  projects: Array<{ id: string; identityId: string; name: string }>;
  facts: Array<{ identityId: string; projectId: string; slot: string; value: string; status: string }>;
  /** Things a file lists with no day ('TBD'), from the newest date batch. */
  undated?: Array<{ project: string; kind: string; title: string }>;
  /** The projects a weekly meeting is on record for (by id or name), from every date batch not turned down. */
  meetings?: string[];
  /** Uploaded files only the person can file (`unfiledFilesIn`), with the project the interview leaned to. */
  unfiled?: Array<{ id: string; fileName: string; lean?: { id: string } | undefined }>;
  /** The projects (by id or name) a dated item is on record for, from the date batches: their deadline is known without asking. */
  dated?: string[];
  /** One-off dated items on record (`project` by id or name): an undated item that has since been given a day is not asked about. */
  datedItems?: Array<{ project: string; title: string }>;
  /** Titles of events the connected calendars repeat on more than one day: a course whose code is in one meets at those times. */
  calendarRecurring?: string[];
  /** The working portrait, once all its fields are written, and whether the person said it fits them (`profile.confirmed`). */
  portrait?: { written: boolean; confirmed: boolean };
  /** The language the questions and their options are written in (default Chinese). `detail` is for the model and stays as it is. */
  locale?: Locale | undefined;
};
export type ProfileGap = {
  code: "LINE_UNCONFIRMED" | "PROJECT_DEADLINE" | "DATE_UNDATED" | "COURSE_MEETINGS" | "FILE_UNFILED" | "PORTRAIT_UNCONFIRMED" | "APPEARANCE";
  identityId: string; projectId: string;
  /** The file a `FILE_UNFILED` gap is about. */
  documentId?: string;
  /** For the model, when it is told why it may not finish yet. */
  detail: string;
  question: TurnQuestion;
  /** A gap that stops the interview from finishing. An undated item is asked once but does not hold anything up: TBD can be the truth. */
  blocking: boolean;
};

/** Letter grades with the total they ask for: the choices offered when the person changes a course's target. The numbers downstream are derived from the one chosen. */
export const TARGET_GRADE_OPTIONS = [
  { id: "a", label: "总评 A（≥ 93）", detail: "要拿满分档，每个部分都要稳在高位" },
  { id: "a-minus", label: "总评 A−（≥ 90）", detail: "大多数人说的“拿 A”，允许一两处失手" },
  { id: "b-plus", label: "总评 B+（≥ 87）", detail: "稳妥的好成绩" },
  { id: "b", label: "总评 B（≥ 83）", detail: "不拖后腿，把精力留给别的事" },
  { id: "b-minus", label: "总评 B−（≥ 80）", detail: "及格之上，刚好够用" },
  { id: "pass", label: "只要通过（≥ 70）", detail: "这门课只求不挂" },
  { id: "unsure", label: "还没想好，先按 A−（≥ 90）规划", detail: "之后随时可以改，里程碑的分数线会跟着重算" }
] as const;

/** Kinds that only a course has: an exam alone could be a qualifying exam, a quiz or a homework set is a class. */
const COURSE_KINDS = new Set(["quiz", "homework_out", "homework_due"]);
/**
 * Whether a project is a course: it has a grade breakdown on record, or its own files date quizzes or homework. The breakdown alone was
 * not enough — a real interview recorded a syllabus's dates and never its percentages, so the check that asks for a target grade
 * never fired on the account it was written for.
 */
export function isCourse(projectId: string, facts: Array<{ projectId: string; slot: string }>,
  dates: Array<{ project: string; kind: string }> = [], undated: Array<{ project: string; kind: string }> = []): boolean {
  return facts.some((fact) => fact.projectId === projectId && fact.slot === "grading")
    || [...dates, ...undated].some((entry) => entry.project === projectId && COURSE_KINDS.has(entry.kind));
}

const GRADED_KINDS = new Set(["quiz", "exam", "homework_due", "homework_out", "project_due"]);
const confirmed = (fact: { status: string }) => fact.status === "confirmed";
const flywheel = (slot: string) => slot.startsWith("flywheel_");

export function profileGaps(input: ProfileGapInput): ProfileGap[] {
  const t = tFor(input.locale);
  const gaps: ProfileGap[] = [];
  const lineLabel = new Map(input.identities.map((identity) => [identity.id, identity.label]));

  // A line that rests only on the interviewer's own guesses has not been told anything yet.
  for (const identity of input.identities) {
    const own = input.facts.filter((fact) => fact.identityId === identity.id && !flywheel(fact.slot));
    if (own.some(confirmed)) continue;
    // A line nothing has been said about at all is the interview's own job to open; this is for one that rests on guesses alone.
    if (!own.length && !input.projects.some((project) => project.identityId === identity.id)) continue;
    const label = lineLabel.get(identity.id) ?? identity.id;
    gaps.push({
      code: "LINE_UNCONFIRMED", identityId: identity.id, projectId: "", blocking: true,
      // i18n-ignore: what the model is told (`detail` is for the model)
      detail: `「${label}」线目前没有任何你确认过的事实，只有推断。要问，或者让人明确说这条线先不规划（记为 slot=skipped 的 confirmed 事实）。`,
      question: {
        id: `gap-line-${identity.id}`, kind: "single", allowOther: true, identityId: identity.id, projectId: "",
        text: t("「{{label}}」主线当前在推进的具体事项？（目前仅有推断）", { label }),
        options: [
          { id: "doing", label: t("有，我来写下具体在做什么"), detail: t("在下面的“其他”里写项目名、截止日期、卡在哪") },
          { id: "later", label: t("有，但现在不想规划"), detail: t("这条线先跳过，之后随时可以回来补") },
          { id: "none", label: t("目前没有在做的事"), detail: t("这条线暂时留空，不为它生成里程碑") }
        ]
      }
    });
  }

  // Every current project needs its deadline, or the person's word that it has none: one of the start items (decided 2026-10-12), and
  // an answer the code can read back — otherwise 「没有截止」 rested on the model remembering to write it as a fact.
  const dated = new Set(input.dated ?? []);
  for (const project of input.projects) {
    if (/-default$/.test(project.id) || dated.has(project.id) || dated.has(project.name)) continue;
    if (input.facts.some((fact) => fact.projectId === project.id && confirmed(fact) && /^deadline$|^date_|^no_deadline$/.test(fact.slot))) continue;
    gaps.push({
      code: "PROJECT_DEADLINE", identityId: project.identityId, projectId: project.id, blocking: true,
      // i18n-ignore: for the model
      detail: `「${project.name}」还不知道截止日期，也没有说明没有截止。`,
      question: {
        id: `gap-deadline-${project.id}`, kind: "single", allowOther: true, identityId: project.identityId, projectId: project.id,
        text: t("「{{project}}」有截止日期吗？", { project: project.name }),
        options: [
          { id: "date", label: t("我来写日期"), detail: t("在“其他”里写日期，例如「2026-12-15」") },
          { id: "none", label: t("没有截止"), detail: t("不设截止，排程按主线份额安排") }
        ]
      }
    });
  }

  // One question per undated thing, asked once. The same TBD row came back in every batch under a new wording (「期末课程项目报告截止」,
  // 「提交 ECE 555 期末课程项目报告」) and twice in one batch (once from the file, once from the reply saying 「还不知道」), and the answer was
  // never read back — so the real account carried two to four identical cards of it that no answer could clear (2026-10-15).
  const undatedSeen = new Set<string>();
  for (const item of input.undated ?? []) {
    if (!GRADED_KINDS.has(item.kind) && item.kind !== "deadline") continue;
    // 「每周作业截止」 recurs on a weekday; asking for 「大致日期」 of it made no sense (2026-10-15 walkthrough).
    if (/每周|每星期|weekly|every week/i.test(item.title)) continue;
    const project = input.projects.find((entry) => entry.id === item.project);
    if (!project) continue;
    const key = undatedKey(item.title);
    if (!key || undatedSeen.has(`${project.id}|${key}`)) continue;
    undatedSeen.add(`${project.id}|${key}`);
    // Answered (any answer, 「还不知道」 included, is kept as an `undated_*` fact naming the item), or since given a day.
    if (input.facts.some((fact) => fact.projectId === project.id && fact.slot.startsWith("undated_") && undatedKey(fact.value).includes(key))) continue;
    if ((input.datedItems ?? []).some((dated) => (dated.project === project.id || dated.project === project.name) && undatedKey(dated.title) === key)) continue;
    gaps.push({
      code: "DATE_UNDATED", identityId: project.identityId, projectId: project.id, blocking: false,
      // i18n-ignore: for the model (and the start of the stored answer)
      detail: `「${project.name}」的「${item.title}」文件里写的是待定，不是日期。`,
      question: {
        id: `gap-undated-${project.id}-${key.slice(0, 30)}`, kind: "single", allowOther: true,
        identityId: project.identityId, projectId: project.id,
        text: t("「{{project}}」的「{{item}}」在文件中标为待定，大致日期？", { project: project.name, item: item.title }),
        options: [
          { id: "known", label: t("知道具体日期，我来写"), detail: t("在“其他”里写日期，里程碑会按它排") },
          { id: "last-week", label: t("学期最后一周前后"), detail: t("里程碑按学期最后一周之前暂定，通知下来再改") },
          { id: "exam-week", label: t("和期末考试差不多的时候"), detail: t("里程碑按期末前暂定，通知下来再改") },
          { id: "unknown", label: t("还不知道"), detail: t("里程碑先放一个暂定日期并标明待确认") }
        ]
      }
    });
  }

  const COURSE_PART = /项目|作业|考试|测验|报告|论文|展示|project|homework|assignment|exam|quiz|report|paper|presentation/i;
  // A course meets: when nobody has said when, ask, with the files as one answer (an interview had two courses and asked about one).
  const meets = new Set(input.meetings ?? []);
  for (const project of input.projects) {
    const own = input.facts.filter((fact) => fact.projectId === project.id && confirmed(fact));
    const code = courseCodeOf(project.name) ?? courseCodeOf(project.id);
    const course = Boolean(code) || own.some((fact) => fact.slot === "grading");
    if (!course || meets.has(project.id) || meets.has(project.name) || own.some((fact) => MEETING_SLOT.test(fact.slot))) continue;
    // A part of a course (its final project, an exam) does not meet on its own; nor does a course whose class times another project with
    // the same code already holds. Asking when 「RBT 610 期末项目」 meets was found walking the app as an invitee (2026-10-15).
    if (!own.some((fact) => fact.slot === "grading") && COURSE_PART.test(project.name)) continue;
    if (code && input.projects.some((other) => other.id !== project.id && (meets.has(other.id) || meets.has(other.name))
      && (courseCodeOf(other.name) ?? courseCodeOf(other.id)) === code)) continue;
    // A course the connected calendar already repeats every week meets at those times: read, not asked.
    if (code && (input.calendarRecurring ?? []).some((title) => squashCode(title).includes(squashCode(code)))) continue;
    // Only when it meets, never where: the room does not change the schedule (2026-10-15, 「ECE 548 上课地点」 asked twice).
    gaps.push({
      code: "COURSE_MEETINGS", identityId: project.identityId, projectId: project.id, blocking: false,
      // i18n-ignore: for the model
      detail: `「${project.name}」还不知道每周什么时候上课。`,
      question: {
        id: `gap-meetings-${project.id}`, kind: "single", allowOther: true, identityId: project.identityId, projectId: project.id,
        text: t("「{{project}}」每周什么时候上课？", { project: project.name }),
        options: [
          { id: "write", label: t("我来写上课时间"), detail: t("在“其他”里写，例如「周二、四 11:00–12:15」") },
          { id: "file", label: t("上传的课程文件里有"), detail: t("访谈会从文件里读出，读出后请确认") },
          { id: "none", label: t("没有固定上课时间"), detail: t("线上或自学，不占每周的固定时段") }
        ]
      }
    });
  }

  // Which project a file belongs to, when nothing on record says: asked inside the interview while it runs.
  for (const file of input.unfiled ?? []) {
    const lean = input.projects.find((project) => project.id === file.lean?.id);
    const ordered = lean ? [lean, ...input.projects.filter((project) => project !== lean)] : input.projects;
    gaps.push({
      code: "FILE_UNFILED", identityId: "", projectId: "", documentId: file.id, blocking: false,
      // i18n-ignore: for the model
      detail: `《${file.fileName}》的所属项目不确定。`,
      question: {
        id: `gap-file-${file.id}`, kind: "single", allowOther: false, identityId: "", projectId: "",
        text: t("《{{file}}》属于哪个项目？", { file: file.fileName }),
        options: [
          ...ordered.slice(0, 8).map((project) => ({ id: project.id, label: project.name,
            detail: project === lean ? t("访谈判断更可能是它") : lineLabel.get(project.identityId) ?? "" })),
          { id: "none", label: t("不属于任何项目"), detail: t("作为通用资料保留") }
        ]
      }
    });
  }

  // The portrait is the person's to recognise: once it is written, they are asked whether it fits.
  if (input.portrait?.written && !input.portrait.confirmed) gaps.push({
    code: "PORTRAIT_UNCONFIRMED", identityId: "", projectId: "", blocking: false,
    // i18n-ignore: for the model
    detail: "画像已写完，本人尚未确认。",
    question: {
      id: "gap-portrait", kind: "single", allowOther: true, identityId: "", projectId: "",
      text: t("「当前画像」写的是否符合本人？"),
      options: [
        { id: "yes", label: t("符合"), detail: t("画像以此为准；之后改动会再请本人确认") },
        { id: "mostly", label: t("大体符合，有几处要改"), detail: t("在“其他”里写要改哪里") },
        { id: "no", label: t("不符合"), detail: t("在“其他”里写哪里不对") }
      ]
    }
  });

  // The cartoon figure is drawn from how the person says they look (decided 2026-10-14): asked once, beside the portrait, saying what it
  // is for. Never assumed — with nothing said, the figure stays neutral.
  if (input.portrait?.written && !input.facts.some((fact) => fact.identityId === "person" && APPEARANCE_SLOT.test(fact.slot))) gaps.push({
    code: "APPEARANCE", identityId: "person", projectId: "", blocking: false,
    // i18n-ignore: for the model
    detail: "本人外貌未知，画像形象只能用中性默认。",
    question: {
      id: "gap-appearance", kind: "single", allowOther: true, identityId: "person", projectId: "",
      text: t("画像报告会为本人生成一个卡通形象。希望它是什么样子（性别、发型、常穿的衣服或颜色）？这些描述只用于生成形象。"),
      options: [
        { id: "write", label: t("我来描述"), detail: t("在“其他”里写，例如「男，狼尾长发，常穿全黑」") },
        { id: "skip", label: t("不描述，用中性形象"), detail: t("之后在输入框里说一句也能改") }
      ]
    }
  });
  // One question per id, whatever produced it twice: the same id twice is the same card twice, and an answer clears only one of them.
  const seen = new Set<string>();
  return gaps.filter((gap) => !seen.has(gap.question.id) && Boolean(seen.add(gap.question.id)));
}

/** A course code without its space and case (「ECE 548」 and 「ece548」 are one course). */
const squashCode = (text: string) => text.replace(/\s+/g, "").toLowerCase();

/**
 * An undated item's identity across wordings — course codes, the verbs around it (提交, 截止, due) and punctuation removed — so 「期末课程项目
 * 报告截止」, 「提交 ECE 555 期末课程项目报告」 and 「ECE 555 期末课程项目报告截止」 are one item, asked about once.
 */
export function undatedKey(title: string): string {
  return title.replace(/提交|上交|交付|截止|due|submit(?:ted|sion)?|hand[- ]?in|turn[- ]?in|deadline|\b(?:the|a|an)\b/giu, "")
    .replace(/(?<![A-Za-z])[A-Za-z]{2,5}\s?\d{3,4}[A-Za-z]?(?![\dA-Za-z])/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
}

/** Person facts that already say how they look, so the appearance question is not asked. */
const APPEARANCE_SLOT = /^(appearance|appearance_skipped|gender|hairstyle|clothing_preference)$/;

const MEETING_SLOT = /^(meeting|class)_?times?$|^no_meetings$/;

/** Words that say a question from the model already asks what a gap is about, so the code-built one is not asked on top of it. */
const COVERS: Partial<Record<ProfileGap["code"], RegExp>> = {
  PROJECT_DEADLINE: /截止|deadline|什么时候(交|完成)|\bdue\b|when .{0,30}\b(finish|finished|done|submit|hand in)\b/i,
  DATE_UNDATED: /待定|TBD|日期|什么时候|\bdate\b|\bwhen\b/i,
  COURSE_MEETINGS: /上课|几点|每周.*(时间|时段)|\b(class|classes|lecture|lectures)\b.{0,40}\b(meet|meets|time|times|when|schedule)\b|\b(when|what time)\b.{0,40}\b(class|lecture)\b|\bmeets?\b.{0,20}\bweek/i
};

/**
 * Whether one of the model's questions already asks what a gap asks: anything about a line it rests on, or a question on the same
 * project about the same thing. Used where a round is put together and where its open questions are listed, so a person is not asked
 * 「ECE 548 每周固定上课的星期」 and 「「ECE 548」每周什么时候上课」 side by side.
 */
export function gapCoveredBy(gap: ProfileGap, questions: Array<{ identityId: string; projectId: string; text: string }>): boolean {
  if (gap.code === "LINE_UNCONFIRMED") return questions.some((question) => question.identityId === gap.identityId);
  const covers = COVERS[gap.code];
  return Boolean(covers) && questions.some((question) => question.projectId === gap.projectId && covers!.test(question.text));
}

/** Facts as they will stand once a turn's updates are written: a confirmed fact is never replaced by a guess. */
export function mergeFacts<T extends { identityId: string; projectId: string; slot: string; status: string }>(existing: T[], updates: T[]): T[] {
  const key = (fact: T) => `${fact.identityId}\u0000${fact.projectId}\u0000${fact.slot}`;
  const merged = new Map(existing.map((fact) => [key(fact), fact]));
  for (const update of updates) {
    const current = merged.get(key(update));
    if (current && confirmed(current) && !confirmed(update)) continue;
    merged.set(key(update), update);
  }
  return [...merged.values()];
}

/** A fact to write; or, with an empty `slot`, an action: filing a file (`file`), or the person's 「符合」 for the portrait. */
export type GapAnswer = { identityId: string; projectId: string; slot: string; value: string; quote: string;
  file?: { documentId: string; projectId: string }; confirmPortrait?: boolean };

const stable = (text: string) => [...text].reduce((hash, char) => (hash * 31 + char.codePointAt(0)!) >>> 0, 7).toString(36);

/**
 * One answer as the person "says" it: `【question】选择：A；B。补充：text` in Chinese, `[question] Chose: A; B. Added: text` in English.
 * Option labels are written out in full on purpose: the interview grounds every fact in a verbatim quote of the reply, and a bare id would
 * give it nothing to quote. `answeredGapFacts` reads both forms back, whichever language the screen was in when it was written.
 */
export function answerLine(questionText: string, labels: string[], other: string, locale?: Locale): string {
  const t = tFor(locale);
  const en = locale === "en";
  const parts = [labels.length ? t("选择：{{labels}}", { labels: labels.join(en ? "; " : "；") }) : "",
    other.trim() ? t("补充：{{text}}", { text: other.trim() }) : ""].filter(Boolean);
  return en ? `[${questionText}] ${parts.join(". ")}` : `【${questionText}】${parts.join("。")}`;
}

/** The picked labels and the person's own words in the rest of an answer line (after its marker), in either language. */
export function readAnswerLine(line: string): { picked: string[]; other: string } {
  const zhPicked = /选择：([^。]*)/.exec(line)?.[1];
  const enPicked = /(?:^|\s)Chose: (.*?)(?:\. Added: |\.\s*$|$)/.exec(line)?.[1];
  const picked = (zhPicked ?? enPicked ?? "").split(/；|; /).map((item) => item.trim()).filter(Boolean);
  const other = (/补充：(.*)$/.exec(line)?.[1] ?? /(?:^|\s|\.)\s*Added: (.*)$/.exec(line)?.[1] ?? "").trim();
  return { picked, other };
}

/**
 * Whether a picked label means this option: the same words, or the same option in the other language — a round asked in one language
 * can be answered after the screen was switched to the other.
 */
const sameOption = (label: string, picked: string) => {
  const en = tFor("en");
  return picked === label || en(label) === picked || en(picked) === label;
};

/**
 * What the person's answers to the code-built questions say, as facts. The message the screen sends is `【question】选择：label。补充：text`
 * (`composeAnswers`; in English `[question] Chose: label. Added: text`, see `answerLine`), so the answer is read straight out of it and
 * written without asking the model to remember to: the label or the typed text is a verbatim span of the reply, which is all a confirmed
 * fact needs. A line answered 「有，我来写」 is not a fact yet; only what they then write is.
 */
export function answeredGapFacts(replyText: string, gaps: ProfileGap[]): GapAnswer[] {
  const out: GapAnswer[] = [];
  const en = tFor("en");
  for (const gap of gaps) {
    // A round stored before the portrait question was reworded still shows, and is answered in, its old words.
    /* i18n-ignore-start: earlier wordings, matched against stored replies */
    const texts = gap.code === "PORTRAIT_UNCONFIRMED" ? [gap.question.text, "「当前画像」里写的是否符合你？"]
      : gap.code === "COURSE_MEETINGS" ? [gap.question.text, gap.question.text.replace(/？$/, "、在哪里？")] : [gap.question.text];
    /* i18n-ignore-end */
    // The question in the other language too: the round may have been written before the screen was switched.
    const both = [...new Set(texts.flatMap((text) => [text, en(text)]))];
    const marker = both.flatMap((text) => [`【${text}】`, `[${text}]`]).find((candidate) => replyText.includes(candidate)) ?? "";
    const at = marker ? replyText.indexOf(marker) : -1;
    if (at < 0) continue;
    const line = replyText.slice(at + marker.length).split("\n")[0] ?? "";
    const { picked, other } = readAnswerLine(line);
    // The label as the person picked it (their words, so the quote stays verbatim) for the option with this id, if they picked it.
    const pickedFor = (id: string) => {
      const option = gap.question.options.find((item) => item.id === id);
      return option ? picked.find((label) => sameOption(option.label, label)) : undefined;
    };
    const base = { identityId: gap.identityId, projectId: gap.projectId };
    if (gap.code === "LINE_UNCONFIRMED") {
      const declined = gap.question.options.filter((option) => option.id !== "doing").map((option) => pickedFor(option.id)).find(Boolean);
      if (other) out.push({ ...base, slot: "what", value: other, quote: other });
      else if (declined) out.push({ ...base, slot: "skipped", value: declined, quote: declined });
    } else if (gap.code === "PROJECT_DEADLINE") {
      const none = pickedFor("none");
      if (other) out.push({ ...base, slot: "deadline", value: other, quote: other });
      else if (none) out.push({ ...base, slot: "no_deadline", value: none, quote: none });
    } else if (gap.code === "DATE_UNDATED") {
      // 「知道具体日期」 without the date is not an answer.
      const value = other || gap.question.options.filter((option) => option.id !== "known").map((option) => pickedFor(option.id)).find(Boolean);
      if (value) out.push({ ...base, slot: `undated_${stable(gap.question.id)}`, value: `${gap.detail}${value}`, quote: value });
    } else if (gap.code === "COURSE_MEETINGS") {
      // The times themselves go to the interview, which turns them into a weekly pattern the person confirms; this only records them.
      const none = pickedFor("none");
      if (other) out.push({ ...base, slot: "meeting_times", value: other, quote: other });
      else if (none) out.push({ ...base, slot: "no_meetings", value: none, quote: none });
    } else if (gap.code === "FILE_UNFILED") {
      const option = gap.question.options.find((item) => picked.some((label) => sameOption(item.label, label)));
      const label = option ? pickedFor(option.id)! : "";
      if (option) out.push({ identityId: "", projectId: "", slot: "", value: label, quote: label,
        file: { documentId: gap.documentId ?? "", projectId: option.id === "none" ? "" : option.id } });
    } else if (gap.code === "APPEARANCE") {
      const skip = pickedFor("skip");
      if (other) out.push({ ...base, slot: "appearance", value: other, quote: other });
      else if (skip) out.push({ ...base, slot: "appearance_skipped", value: skip, quote: skip });
    } else if (gap.code === "PORTRAIT_UNCONFIRMED") {
      const yes = pickedFor("yes");
      if (yes) out.push({ identityId: "", projectId: "", slot: "", value: yes, quote: yes, confirmPortrait: true });
    }
  }
  return out;
}

/** Why one of the interview's own questions is kept from the person (rule 「只问只有本人知道、而且会改变计划的事」, 2026-10-15). */
export type ScreenReason = "location" | "known_schedule" | "calendar_inferable";
export const SCREEN_REASON_LABEL: Record<ScreenReason, string> = {
  location: "只问地点，地点不影响排程",
  known_schedule: "上课时间已在文件、日历或回答里",
  calendar_inferable: "日历活动是否每周重复，按日历自身的重复规则判断"
};
export type QuestionScreenInput = {
  projects: Array<{ id: string; name: string }>;
  /** Projects (by id or name) whose weekly meetings are on record: a fact, a recurring item of a date batch. */
  meetings: string[];
  /** Titles the connected calendars repeat on more than one day. */
  calendarRecurring?: string[];
};

const PLACE = /地点|在哪|教室|房间|地址|location|where|room|building|venue|address/i;
const WHEN = /星期|周[一二三四五六日天几]|哪几天|几号|几点|时间|时段|起止|什么时候|哪天|日期|频率|多久|多长|结束|开始|几次|when|time|day|hour|date|weekday|how often|how long|start|end/i;
const CLASS = /上课|课程?时间|课时|lecture|class/i;
const CALENDAR = /日历|calendar/i;
const RECURRENCE = /持续|重复|周期|每周都|每月|一次性|固定安排|长期安排|循环|recurr|one-?off|repeat|ongoing|every week|every month|monthly|regular/i;

/**
 * The interview's questions that are not the person's to answer, taken out before a round is stored or listed: one that asks only where
 * something happens (the room never changes the schedule), one that asks when a course meets when the files, the calendar or an earlier
 * answer already say, and one that asks which calendar events are ongoing — the calendar's own recurrence and common sense decide that,
 * and a single choice over two events gave a wrong combination (「DEJA-VU 每月固定」 picked alone, Build Nights dropped). The app's own
 * questions (`gap-*`) are built only when needed and are never screened here.
 */
export function screenQuestions<Q extends { id: string; text: string; projectId: string }>(questions: Q[], input: QuestionScreenInput):
  { keep: Q[]; screened: Array<{ question: Q; reason: ScreenReason }> } {
  const known = new Set(input.meetings.map(squashCode));
  const meets = (projectId: string, text: string) => {
    const project = input.projects.find((item) => item.id === projectId);
    if (project && (known.has(squashCode(project.id)) || known.has(squashCode(project.name)))) return true;
    const code = courseCodeOf(text.replace(/[?？]/gu, ""));
    if (!code) return false;
    const named = input.projects.filter((item) => (courseCodeOf(item.name) ?? courseCodeOf(item.id)) === code);
    return named.some((item) => known.has(squashCode(item.id)) || known.has(squashCode(item.name)))
      || (input.calendarRecurring ?? []).some((title) => squashCode(title).includes(squashCode(code)));
  };
  const keep: Q[] = [], screened: Array<{ question: Q; reason: ScreenReason }> = [];
  for (const question of questions) {
    const reason: ScreenReason | undefined = question.id.startsWith("gap-") ? undefined
      : CALENDAR.test(question.text) && RECURRENCE.test(question.text) ? "calendar_inferable"
      : PLACE.test(question.text) && !WHEN.test(question.text) ? "location"
      : CLASS.test(question.text) && WHEN.test(question.text) && meets(question.projectId, question.text) ? "known_schedule"
      : undefined;
    if (reason) screened.push({ question, reason }); else keep.push(question);
  }
  return { keep, screened };
}

/** What is written in place of a screened question that something rests on: an assumption the person can correct (only the calendar's). */
// i18n-ignore-start: an assumption written for the interview model to read (「假设：」 marks it as such)
export function screenAssumption(item: { question: { id: string; text: string; identityId: string; projectId: string }; reason: ScreenReason }):
  { identityId: string; projectId: string; slot: string; value: string } | undefined {
  if (item.reason !== "calendar_inferable") return undefined;
  return { identityId: item.question.identityId || "person", projectId: item.question.projectId, slot: `assumed_${stable(item.question.id)}`,
    value: `假设：${item.question.text.replace(/[？?]$/u, "")}——按日历自身的重复规则判断：重复的系列视为持续安排，单次事件视为一次性。本人说一句即可更正。` };
}

// i18n-ignore-end
/** A line for the interview, sent with a round answered on 待决事项, naming the questions the app kept from the person and why. */
export function screenedNote(screened: Array<{ question: { text: string }; reason: ScreenReason }>): string {
  if (!screened.length) return "";
  /* i18n-ignore-start: a note to the interview model */
  return `（系统说明，不是本人的回答：以下问题未交给本人——${screened.map((item) => `「${item.question.text}」（${SCREEN_REASON_LABEL[item.reason]}）`).join("；")}。`
    + "不必再问；需要时按已有记录和常识自行判断，记为「假设：」。）";
  /* i18n-ignore-end */
}

/**
 * A step plan's question the task's own material answers — the problem set and how many problems, how and where it is handed in, the
 * format and length, the rules on collaboration and AI, the grading rubric, the due time. When the task has files these are read from
 * them (by the assistant and the next plan), never asked; whatever the files do not say is assumed (the owner's decision, 2026-10-15:
 * 「作业 3 题面及题目数」「作业提交方式」「协作与 AI 使用规则」 were put to the person for a homework whose handout was on record).
 */
const FROM_MATERIAL = /题面|题目|几道|题数|多少题|提交(方式|平台|渠道|格式|位置|地址)|怎么提交|如何提交|交到哪|格式要求|页数|字数|篇幅|协作(与|和)?.{0,6}规则|合作规则|AI.{0,4}(使用|规则|政策)|使用\s*AI|评分(标准|细则|方式)|rubric|截止(时间|日期)|几点截止|submission|handout|problem set|how many (problems|questions)|number of (problems|questions)|how (to|do i|should i) (submit|hand in|turn in)|where to (submit|hand in|turn in)|required format|format requirements|page (limit|count)|word (limit|count)|length limit|collaboration (policy|rules)|(ai|chatgpt|llm) (use|usage|policy|rules)|use of (ai|chatgpt)|grading (criteria|scheme|policy)|due (time|date)|what time .{0,20}\bdue\b/i;
export function readableFromMaterial(questionText: string): boolean {
  return FROM_MATERIAL.test(questionText);
}
