import { QUIZ_ITEMS } from "@crossline/core/assess";
import { NICKNAME_MAX, NOTE_MAX, TESTS_PER_EMAIL, type Appearance, type SubmitRequest } from "./contract";

/**
 * The test's own state, kept pure so the pages stay thin and the rules are tested: intro → 32 statements one per screen → appearance →
 * email. The whole state (bar the honeypot) is kept in sessionStorage under one key per invitation, so a reload resumes where it was.
 */
export type Step = "intro" | "quiz" | "appearance" | "email";

/** Appearance while it is being chosen: every choice starts unset, so nobody gets a figure from a default they never looked at. */
export type AppearanceDraft = Partial<Omit<Appearance, "note">> & { note: string };

export type Flow = {
  step: Step;
  /** The statement on screen, 0–31. */
  index: number;
  answers: Record<string, number>;
  /** When the first statement was shown (ms); the server refuses a test finished impossibly fast. */
  startedAt: number | null;
  appearance: AppearanceDraft;
  email: string;
  nickname: string;
  sendEmail: boolean;
};

export const QUIZ_LENGTH = QUIZ_ITEMS.length;

export const emptyFlow = (): Flow => ({
  step: "intro", index: 0, answers: {}, startedAt: null, appearance: { note: "" }, email: "", nickname: "", sendEmail: true
});

export const answeredCount = (flow: Flow): number => QUIZ_ITEMS.filter((item) => isAnswer(flow.answers[item.id])).length;
const isAnswer = (value: unknown): value is number => typeof value === "number" && [1, 2, 3, 4, 5].includes(value);
const firstUnanswered = (answers: Record<string, number>): number => {
  const index = QUIZ_ITEMS.findIndex((item) => !isAnswer(answers[item.id]));
  return index < 0 ? QUIZ_LENGTH : index;
};

/** Show the statements: the clock starts with the first one shown and never restarts, and a returning person lands on the first gap. */
export function startQuiz(flow: Flow, now: number): Flow {
  const gap = firstUnanswered(flow.answers);
  return { ...flow, step: "quiz", index: gap < QUIZ_LENGTH ? gap : QUIZ_LENGTH - 1, startedAt: flow.startedAt ?? now };
}

/**
 * Answer the statement on screen and move on: to the next statement, to the first one still open, or — with all 32 answered — to the
 * appearance step. A value outside 1–5 changes nothing.
 */
export function answerCurrent(flow: Flow, value: number): Flow {
  const answered = setAnswer(flow, value);
  return answered === flow ? flow : advance(answered);
}

/** Record an answer to the statement on screen without moving (an arrow key between the options; auto-advance follows a moment later). */
export function setAnswer(flow: Flow, value: number): Flow {
  if (flow.step !== "quiz" || !isAnswer(value)) return flow;
  const item = QUIZ_ITEMS[flow.index];
  if (!item) return flow;
  return { ...flow, answers: { ...flow.answers, [item.id]: value } };
}

/** The 「下一题」 button and Enter: only past an answered statement. */
export function next(flow: Flow): Flow {
  if (flow.step !== "quiz") return flow;
  const item = QUIZ_ITEMS[flow.index];
  if (!item || !isAnswer(flow.answers[item.id])) return flow;
  return advance(flow);
}

function advance(flow: Flow): Flow {
  if (flow.index + 1 < QUIZ_LENGTH) return { ...flow, index: flow.index + 1 };
  const gap = firstUnanswered(flow.answers);
  return gap < QUIZ_LENGTH ? { ...flow, index: gap } : { ...flow, step: "appearance" };
}

/** One step back: the previous statement, the intro before the first, the last statement before the appearance step. */
export function back(flow: Flow): Flow {
  switch (flow.step) {
    case "quiz": return flow.index > 0 ? { ...flow, index: flow.index - 1 } : { ...flow, step: "intro" };
    case "appearance": return { ...flow, step: "quiz", index: QUIZ_LENGTH - 1 };
    case "email": return { ...flow, step: "appearance" };
    default: return flow;
  }
}

/** The five appearance questions, in screen order. `glasses` is a yes/no choice. */
export const APPEARANCE_FIELDS = [
  { key: "presentation", label: "性别呈现" },
  { key: "hair", label: "发型" },
  { key: "glasses", label: "眼镜" },
  { key: "skin", label: "肤色" },
  { key: "style", label: "穿衣风格" }
] as const;

/** Labels of the appearance questions still unanswered. */
export const appearanceMissing = (draft: AppearanceDraft): string[] =>
  APPEARANCE_FIELDS.filter((field) => draft[field.key] === undefined).map((field) => field.label);

/** Characters as a person counts them (a Chinese character or an emoji is one). */
export const charCount = (text: string): number => Array.from(text).length;

export function noteProblem(note: string): string | null {
  return charCount(note.trim()) > NOTE_MAX ? `补充描述最多 ${NOTE_MAX} 个字` : null;
}

/** The appearance step's one message, or null when it can go on. */
export function appearanceProblem(draft: AppearanceDraft): string | null {
  const missing = appearanceMissing(draft);
  if (missing.length) return `还差：${missing.join("、")}`;
  return noteProblem(draft.note);
}

export function completeAppearance(draft: AppearanceDraft): Appearance | null {
  if (appearanceProblem(draft)) return null;
  return { presentation: draft.presentation!, hair: draft.hair!, glasses: draft.glasses!, skin: draft.skin!, style: draft.style!, note: draft.note.trim() };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@.]+$/;

export function emailProblem(email: string): string | null {
  const value = email.trim();
  if (!value) return "请填写邮箱";
  if (value.length > 254 || !EMAIL.test(value)) return "邮箱格式不对，请检查";
  return null;
}

export function nicknameProblem(nickname: string): string | null {
  return charCount(nickname.trim()) > NICKNAME_MAX ? `署名最多 ${NICKNAME_MAX} 个字` : null;
}

/** The request the email step posts, or null while anything is incomplete. */
export function buildRequest(flow: Flow, extra: { website: string; inviteToken?: string | undefined }): SubmitRequest | null {
  const appearance = completeAppearance(flow.appearance);
  if (!appearance || answeredCount(flow) < QUIZ_LENGTH || emailProblem(flow.email) || nicknameProblem(flow.nickname)) return null;
  const answers = Object.fromEntries(QUIZ_ITEMS.map((item) => [item.id, flow.answers[item.id]!]));
  return {
    answers, appearance, email: flow.email.trim(), sendEmail: flow.sendEmail, nickname: flow.nickname.trim(),
    ...(extra.inviteToken ? { inviteToken: extra.inviteToken } : {}),
    startedAt: flow.startedAt ?? Date.now(), website: extra.website
  };
}

/** sessionStorage key: one test in progress per invitation, and one of the person's own. */
export const flowKey = (inviteToken?: string): string => `crossline-assess:flow:${inviteToken ?? "self"}`;
/** localStorage key of the person's latest result, so the landing page can offer 「查看我的结果」. */
export const LAST_RESULT_KEY = "crossline-assess:last-result";

const STEPS: Step[] = ["intro", "quiz", "appearance", "email"];
const OPTIONS: Record<keyof Omit<Appearance, "note" | "glasses">, readonly string[]> = {
  presentation: ["female", "male", "neutral"], hair: ["short", "medium", "long", "curly", "tied", "bald"],
  skin: ["light", "medium", "deep"], style: ["casual", "smart", "sporty", "artsy"]
};

/**
 * A stored flow read back, every field checked: anything malformed is dropped rather than trusted, and a step that is no longer
 * reachable (appearance with statements missing, say) falls back to the first open statement.
 */
export function parseFlow(raw: string | null): Flow | null {
  if (!raw) return null;
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!data || typeof data !== "object") return null;
  const stored = data as Record<string, unknown>;
  const flow = emptyFlow();
  const answers = stored.answers && typeof stored.answers === "object" ? stored.answers as Record<string, unknown> : {};
  for (const item of QUIZ_ITEMS) if (isAnswer(answers[item.id])) flow.answers[item.id] = answers[item.id] as number;
  if (typeof stored.startedAt === "number" && Number.isFinite(stored.startedAt)) flow.startedAt = stored.startedAt;
  const look = stored.appearance && typeof stored.appearance === "object" ? stored.appearance as Record<string, unknown> : {};
  for (const [key, values] of Object.entries(OPTIONS)) {
    if (typeof look[key] === "string" && values.includes(look[key] as string)) (flow.appearance as Record<string, unknown>)[key] = look[key];
  }
  if (typeof look.glasses === "boolean") flow.appearance.glasses = look.glasses;
  if (typeof look.note === "string") flow.appearance.note = look.note.slice(0, NOTE_MAX * 2);
  if (typeof stored.email === "string") flow.email = stored.email.slice(0, 254);
  if (typeof stored.nickname === "string") flow.nickname = stored.nickname.slice(0, NICKNAME_MAX * 2);
  if (typeof stored.sendEmail === "boolean") flow.sendEmail = stored.sendEmail;
  const step = STEPS.includes(stored.step as Step) ? stored.step as Step : "intro";
  const index = typeof stored.index === "number" && Number.isInteger(stored.index) ? Math.min(Math.max(stored.index, 0), QUIZ_LENGTH - 1) : 0;
  const gap = firstUnanswered(flow.answers);
  if ((step === "appearance" || step === "email") && gap < QUIZ_LENGTH) return { ...flow, step: "quiz", index: gap };
  if (step === "quiz" && flow.startedAt === null) return { ...flow, step: "intro" };
  return { ...flow, step, index };
}

/** What each refusal means to the person, in a sentence they can act on. */
const ERROR_TEXT: Record<string, string> = {
  QUIZ_INCOMPLETE: "还有题没答完，请返回补上。",
  APPEARANCE_INVALID: "外貌的选择不完整，请返回检查。",
  EMAIL_INVALID: "邮箱格式不对，请检查。",
  NICKNAME_INVALID: `署名不能用，请换一个（最多 ${NICKNAME_MAX} 个字）。`,
  TOO_FAST: "提交得太快了，需要确认是真人在答题。请等几秒再点「看结果」。",
  REJECTED: "这次提交没有通过检查。请刷新页面后再试。",
  RATE_LIMITED: "提交太频繁了，请过几分钟再试。",
  INVITE_NOT_FOUND: "这个邀请链接已失效（过期或已被删除）。可以不带邀请提交，只是不会生成双人卡。",
  ALREADY_PAIRED: "这是你自己的邀请链接。把它转发给朋友，让 TA 来测。",
  NOT_FOUND: "没有找到这个结果，可能已过期或已被删除。",
  EMAIL_LIMIT_REACHED: `这个邮箱已测满 ${TESTS_PER_EMAIL} 次，只保留最新一次的结果。最新结果的链接已重新发到这个邮箱；想再测，可以换一个邮箱。`,
  NETWORK: "网络连不上，请检查网络后重试。"
};

export const errorMessage = (code: string): string => ERROR_TEXT[code] ?? "出了点问题，请稍后再试。";
