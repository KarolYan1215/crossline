import { validateWantLines, wantsPlan, type WantLines, type WantsInput } from "@crossline/core/assess-wants";
import type { Locale } from "../../lib/i18n";
import { publicType } from "../../lib/public-type";
import { dailyLimit, takeSlot } from "../avatar/budget";
import { posterFonts } from "../poster/fonts";
import type { StoredResult } from "../store";
import { wantsMessages } from "./prompt";
import { TextModelError, jsonFromAnswer, textModelFromEnv, textModelSummary, type TextModel } from "./text-model";

/**
 * 「你也许想做」 from what the person said (2026-10-16): the owner's written combination when it fits, else a text model's answer when
 * one is configured and today's budget allows, else the rules. Every way ends in valid lines — a model that is off, slow, refuses or
 * answers badly costs the person nothing but the copy — and every fallback from the model is logged (`wants.model_failed`,
 * `wants.skipped`), so it is never silent.
 */

/** The model's call and its one repair together; the person is on the last step meanwhile and their figure is being drawn. */
export const TEXT_TIMEOUT_MS = 25_000;
export const DEFAULT_TEXT_DAILY_LIMIT = 1000;

type Runtime = { model: TextModel | null; now: () => Date };

let announced = false;
let runtime: Runtime | undefined;

const defaults = (): Runtime => {
  if (!announced) {
    announced = true;
    console.info(JSON.stringify({ event: "wants.text_model", ...textModelSummary() }));
  }
  return { model: textModelFromEnv(), now: () => new Date() };
};
const current = (): Runtime => (runtime ??= defaults());

/** Replaces the model or the clock (tests); `null` means none. */
export function configureWants(overrides: Partial<Runtime>): void {
  runtime = { ...defaults(), ...overrides };
}

/** Whether the poster's sans face can print every character (else a character would print as 「·」). */
function printable(lines: WantLines): boolean {
  let glyphs: Set<string>;
  try { glyphs = posterFonts().glyphs.Sans; } catch { return true; }
  const text = [...lines.lines.flatMap((line) => [line.domain, line.identity]), ...lines.loop, ...lines.links.flatMap((link) => [link.kind, link.how])].join("");
  return [...text].every((char) => char === " " || glyphs.has(char));
}

/** What is wrong with one answer, or the lines when nothing is. */
function judge(answer: string, locale?: Locale): { ok: true; lines: WantLines } | { ok: false; problem: string } {
  const checked = validateWantLines(jsonFromAnswer(answer), locale);
  if (!checked.ok) return { ok: false, problem: `TEXT_ANSWER_INVALID: ${checked.problems.slice(0, 4).join("; ").slice(0, 200)}` };
  if (!printable(checked.value)) return { ok: false, problem: "TEXT_ANSWER_UNPRINTABLE" };
  return { ok: true, lines: checked.value };
}

/**
 * One call and, when the answer breaks a rule, one repair in the same conversation with what was wrong: DeepSeek V4's first answers wrote
 * loop steps of 11–17 characters where the poster's boxes hold 10 (2026-10-16), and a second look costs seconds where the rules' lines
 * lose what the person wrote.
 */
async function askModel(model: TextModel, result: StoredResult, wants: WantsInput, locale?: Locale): Promise<WantLines> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEXT_TIMEOUT_MS);
  try {
    const messages = wantsMessages(publicType(result.scores, {}, result.id, undefined, result.aiDoes, locale), wants, locale);
    const answer = await model.complete(messages, controller.signal);
    const first = judge(answer, locale);
    if (first.ok) return first.lines;
    const repaired = judge(await model.complete([...messages, { role: "assistant", content: answer },
      { role: "user", content: repairMessage(first.problem, locale) }], controller.signal), locale);
    if (repaired.ok) return repaired.lines;
    throw new TextModelError(repaired.problem, 422);
  } catch (error) {
    if (controller.signal.aborted) throw new TextModelError("TEXT_TIMEOUT", 504);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** The second turn when the first answer broke a rule (instructions to the model, in the language it is writing in). */
function repairMessage(problem: string, locale?: Locale): string {
  if (locale === "en") return `That answer breaks the rules: ${problem}. Fix it by the rules (every field within its length range) and output only JSON.`;
  return `这个回答不合规则：${problem}。按规则改好（每个字段的字数都要在范围内），只输出 JSON。`; // i18n-ignore: an instruction to the model
}

/**
 * The three lines for this result and what the person said, written in `locale` — the language of the page they answered on: the
 * written combination and the rules in that language, and the model asked to write in it. Never throws.
 */
export async function composeWants(result: StoredResult, wants: WantsInput, locale?: Locale): Promise<WantLines> {
  const plan = wantsPlan(result.code, wants, locale);
  if (!plan.needsModel) return plan.lines;
  const { model, now } = current();
  if (!model) return plan.lines;
  if (!takeSlot(dailyLimit(process.env, "ASSESS_TEXT_DAILY_LIMIT", DEFAULT_TEXT_DAILY_LIMIT), now(), "text")) {
    console.warn(JSON.stringify({ event: "wants.skipped", resultId: result.id, reason: "daily_budget" }));
    return plan.lines;
  }
  const started = Date.now();
  try {
    const lines = await askModel(model, result, wants, locale);
    console.info(JSON.stringify({ event: "wants.model_ready", resultId: result.id, model: model.label, seconds: Math.round((Date.now() - started) / 1000) }));
    return lines;
  } catch (error) {
    console.warn(JSON.stringify({ event: "wants.model_failed", resultId: result.id, model: model.label, fallback: plan.lines.source,
      ...(error instanceof TextModelError ? { status: error.status } : {}),
      reason: error instanceof Error ? error.message.slice(0, 200) : "unknown" }));
    return plan.lines;
  }
}
