import { isWebUrl, type DimensionId, type ResearchThread } from "./onboarding-turn-schema";

/**
 * One run of an interview's research thread (contract C, 2026-11-12, Skill `crossline-onboarding-research`): a question the dialogue
 * found worth looking into on the web (a role's requirements, how common something is among people like them, the literature behind an
 * inference, the outside background of something they lived through), answered on its own long thread so the conversation is not held up.
 * Each run says what it found (`message`), asks the person only what it cannot find out itself (`ask`), and ends with a `conclusion` once
 * it has one. Every source is a page it opened, with its URL.
 */
export type ResearchTurn = { message: string; ask?: string; conclusion?: string; sources: Array<{ title: string; url: string }> };

/** What a research run is shown: the question, the portrait in brief, and the thread so far (the person's answers included). */
export type OnboardingResearchContext = {
  version: "crossline.onboarding.research.v1";
  today: string;
  question: string; why: string; dimension: DimensionId;
  /** The working portrait in brief: lines, the hypotheses that bear on the question, facts the question needs. */
  profile: string[];
  /** The thread so far, oldest first; the last `person` message is what the person just answered or asked. */
  messages: ResearchThread["messages"];
};

const object = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
/** `ask` and `conclusion` are "" for none: a plain string is easier on every provider than a union with null. */
export const ONBOARDING_RESEARCH_SCHEMA = object({
  message: { type: "string", minLength: 1, maxLength: 1500 },
  ask: { type: "string", maxLength: 400 },
  conclusion: { type: "string", maxLength: 1500 },
  sources: { type: "array", maxItems: 12, items: object({ title: { type: "string", minLength: 1, maxLength: 200 }, url: { type: "string", minLength: 8, maxLength: 500 } }) }
});

/**
 * A research run's answer as the thread keeps it: sources only with a web URL, each once; an empty `ask` or `conclusion` is none. A
 * conclusion with no source left is refused: a number or a finding nobody can open is not a conclusion (the Skill says so too).
 */
export function validateResearchTurn(value: unknown): ResearchTurn {
  const turn = value as Partial<{ message: unknown; ask: unknown; conclusion: unknown; sources: unknown }> | null;
  const message = typeof turn?.message === "string" ? turn.message.trim() : "";
  /* i18n-ignore-start: repair messages to the model */
  if (!message) throw Object.assign(new Error("RESEARCH_MESSAGE_EMPTY"), { detail: "message 不能为空：写这一轮查到了什么。" });
  const seen = new Set<string>();
  const sources = (Array.isArray(turn?.sources) ? turn!.sources as Array<{ title?: unknown; url?: unknown }> : [])
    .filter((source) => typeof source?.title === "string" && source.title.trim() && isWebUrl(source.url) && !seen.has(source.url.trim()) && Boolean(seen.add(source.url.trim())))
    .map((source) => ({ title: String(source.title).trim(), url: String(source.url).trim() }));
  const ask = typeof turn?.ask === "string" ? turn.ask.trim() : "";
  const conclusion = typeof turn?.conclusion === "string" ? turn.conclusion.trim() : "";
  if (conclusion && !sources.length) throw Object.assign(new Error("RESEARCH_CONCLUSION_UNSOURCED"), {
    detail: "conclusion 需要至少一个打开过的来源（sources 里带 http(s) 网址）；没有来源就不写结论，继续查或在 message 里说明查不到。" });
  /* i18n-ignore-end */
  return { message, ...(ask ? { ask } : {}), ...(conclusion ? { conclusion } : {}), sources };
}
