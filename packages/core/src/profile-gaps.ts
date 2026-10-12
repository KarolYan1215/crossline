import type { TurnQuestion } from "./onboarding-turn-schema";
import { courseCodeOf } from "./task-title";

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
  /** The working portrait, once all its fields are written, and whether the person said it fits them (`profile.confirmed`). */
  portrait?: { written: boolean; confirmed: boolean };
};
export type ProfileGap = {
  code: "LINE_UNCONFIRMED" | "DATE_UNDATED" | "COURSE_MEETINGS" | "FILE_UNFILED" | "PORTRAIT_UNCONFIRMED";
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
      detail: `「${label}」线目前没有任何你确认过的事实，只有推断。要问，或者让人明确说这条线先不规划（记为 slot=skipped 的 confirmed 事实）。`,
      question: {
        id: `gap-line-${identity.id}`, kind: "single", allowOther: true, identityId: identity.id, projectId: "",
        text: `「${label}」主线当前在推进的具体事项？（目前仅有推断）`,
        options: [
          { id: "doing", label: "有，我来写下具体在做什么", detail: "在下面的“其他”里写项目名、截止日期、卡在哪" },
          { id: "later", label: "有，但现在不想规划", detail: "这条线先跳过，之后随时可以回来补" },
          { id: "none", label: "目前没有在做的事", detail: "这条线暂时留空，不为它生成里程碑" }
        ]
      }
    });
  }

  for (const item of input.undated ?? []) {
    if (!GRADED_KINDS.has(item.kind) && item.kind !== "deadline") continue;
    const project = input.projects.find((entry) => entry.id === item.project);
    if (!project) continue;
    gaps.push({
      code: "DATE_UNDATED", identityId: project.identityId, projectId: project.id, blocking: false,
      detail: `「${project.name}」的「${item.title}」文件里写的是待定，不是日期。`,
      question: {
        id: `gap-undated-${project.id}-${item.title.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 30)}`, kind: "single", allowOther: true,
        identityId: project.identityId, projectId: project.id,
        text: `「${project.name}」的「${item.title}」在文件中标为待定，大致日期？`,
        options: [
          { id: "known", label: "知道具体日期，我来写", detail: "在“其他”里写日期，里程碑会按它排" },
          { id: "last-week", label: "学期最后一周前后", detail: "里程碑按学期最后一周之前暂定，通知下来再改" },
          { id: "exam-week", label: "和期末考试差不多的时候", detail: "里程碑按期末前暂定，通知下来再改" },
          { id: "unknown", label: "还不知道", detail: "里程碑先放一个暂定日期并标明待确认" }
        ]
      }
    });
  }

  // A course meets: when nobody has said when, ask, with the files as one answer (an interview had two courses and asked about one).
  const meets = new Set(input.meetings ?? []);
  for (const project of input.projects) {
    const own = input.facts.filter((fact) => fact.projectId === project.id && confirmed(fact));
    const course = Boolean(courseCodeOf(project.name) ?? courseCodeOf(project.id)) || own.some((fact) => fact.slot === "grading");
    if (!course || meets.has(project.id) || meets.has(project.name) || own.some((fact) => MEETING_SLOT.test(fact.slot))) continue;
    gaps.push({
      code: "COURSE_MEETINGS", identityId: project.identityId, projectId: project.id, blocking: false,
      detail: `「${project.name}」还不知道每周什么时候上课。`,
      question: {
        id: `gap-meetings-${project.id}`, kind: "single", allowOther: true, identityId: project.identityId, projectId: project.id,
        text: `「${project.name}」每周什么时候上课、在哪里？`,
        options: [
          { id: "write", label: "我来写上课时间", detail: "在“其他”里写，例如「周二、四 11:00–12:15，EH 2317」" },
          { id: "file", label: "上传的课程文件里有", detail: "访谈会从文件里读出，读出后请确认" },
          { id: "none", label: "没有固定上课时间", detail: "线上或自学，不占每周的固定时段" }
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
      detail: `《${file.fileName}》的所属项目不确定。`,
      question: {
        id: `gap-file-${file.id}`, kind: "single", allowOther: false, identityId: "", projectId: "",
        text: `《${file.fileName}》属于哪个项目？`,
        options: [
          ...ordered.slice(0, 8).map((project) => ({ id: project.id, label: project.name,
            detail: project === lean ? "访谈判断更可能是它" : lineLabel.get(project.identityId) ?? "" })),
          { id: "none", label: "不属于任何项目", detail: "作为通用资料保留" }
        ]
      }
    });
  }

  // The portrait is the person's to recognise: once it is written, they are asked whether it fits.
  if (input.portrait?.written && !input.portrait.confirmed) gaps.push({
    code: "PORTRAIT_UNCONFIRMED", identityId: "", projectId: "", blocking: false,
    detail: "画像已写完，本人尚未确认。",
    question: {
      id: "gap-portrait", kind: "single", allowOther: true, identityId: "", projectId: "",
      text: "「当前画像」写的是否符合本人？",
      options: [
        { id: "yes", label: "符合", detail: "画像以此为准；之后改动会再请本人确认" },
        { id: "mostly", label: "大体符合，有几处要改", detail: "在“其他”里写要改哪里" },
        { id: "no", label: "不符合", detail: "在“其他”里写哪里不对" }
      ]
    }
  });
  return gaps;
}

const MEETING_SLOT = /^(meeting|class)_?times?$|^no_meetings$/;

/** Words that say a question from the model already asks what a gap is about, so the code-built one is not asked on top of it. */
const COVERS: Partial<Record<ProfileGap["code"], RegExp>> = {
  DATE_UNDATED: /待定|TBD|日期|什么时候/i,
  COURSE_MEETINGS: /上课|几点|每周.*(时间|时段)/
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
 * What the person's answers to the code-built questions say, as facts. The message the screen sends is `【question】选择：label。补充：text`
 * (`composeAnswers`), so the answer is read straight out of it and written without asking the model to remember to: the label or the typed
 * text is a verbatim span of the reply, which is all a confirmed fact needs. A line answered 「有，我来写」 is not a fact yet; only what
 * they then write is.
 */
export function answeredGapFacts(replyText: string, gaps: ProfileGap[]): GapAnswer[] {
  const out: GapAnswer[] = [];
  for (const gap of gaps) {
    // A round stored before the portrait question was reworded still shows, and is answered in, its old words.
    const texts = gap.code === "PORTRAIT_UNCONFIRMED" ? [gap.question.text, "「当前画像」里写的是否符合你？"] : [gap.question.text];
    const marker = texts.map((text) => `【${text}】`).find((candidate) => replyText.includes(candidate)) ?? "";
    const at = marker ? replyText.indexOf(marker) : -1;
    if (at < 0) continue;
    const line = replyText.slice(at + marker.length).split("\n")[0] ?? "";
    const picked = (/选择：([^。]*)/.exec(line)?.[1] ?? "").split("；").map((item) => item.trim()).filter(Boolean);
    const other = (/补充：(.*)$/.exec(line)?.[1] ?? "").trim();
    const base = { identityId: gap.identityId, projectId: gap.projectId };
    if (gap.code === "LINE_UNCONFIRMED") {
      const declined = picked.find((label) => gap.question.options.some((option) => option.label === label && option.id !== "doing"));
      if (other) out.push({ ...base, slot: "what", value: other, quote: other });
      else if (declined) out.push({ ...base, slot: "skipped", value: declined, quote: declined });
    } else if (gap.code === "DATE_UNDATED") {
      // 「知道具体日期」 without the date is not an answer.
      const value = other || picked.find((label) => gap.question.options.some((option) => option.label === label && option.id !== "known"));
      if (value) out.push({ ...base, slot: `undated_${stable(gap.question.id)}`, value: `${gap.detail}${value}`, quote: value });
    } else if (gap.code === "COURSE_MEETINGS") {
      // The times themselves go to the interview, which turns them into a weekly pattern the person confirms; this only records them.
      if (other) out.push({ ...base, slot: "meeting_times", value: other, quote: other });
      else if (picked.includes("没有固定上课时间")) out.push({ ...base, slot: "no_meetings", value: "没有固定上课时间", quote: "没有固定上课时间" });
    } else if (gap.code === "FILE_UNFILED") {
      const option = gap.question.options.find((item) => picked.includes(item.label));
      if (option) out.push({ identityId: "", projectId: "", slot: "", value: option.label, quote: option.label,
        file: { documentId: gap.documentId ?? "", projectId: option.id === "none" ? "" : option.id } });
    } else if (gap.code === "PORTRAIT_UNCONFIRMED") {
      if (picked.includes("符合")) out.push({ identityId: "", projectId: "", slot: "", value: "符合", quote: "符合", confirmPortrait: true });
    }
  }
  return out;
}
