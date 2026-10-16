import { validateWantLines, wantsPlan, type WantLines, type WantsInput } from "@crossline/core/assess-wants";
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

/** One model call, the answer included; the person is on the last step meanwhile and their figure is being drawn. */
export const TEXT_TIMEOUT_MS = 15_000;
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

async function askModel(model: TextModel, result: StoredResult, wants: WantsInput): Promise<WantLines> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEXT_TIMEOUT_MS);
  try {
    const answer = await model.complete(wantsMessages(publicType(result.scores, {}, result.id), wants), controller.signal);
    const checked = validateWantLines(jsonFromAnswer(answer));
    if (!checked.ok) throw new TextModelError(`TEXT_ANSWER_INVALID: ${checked.problems.slice(0, 4).join("; ").slice(0, 200)}`, 422);
    if (!printable(checked.value)) throw new TextModelError("TEXT_ANSWER_UNPRINTABLE", 422);
    return checked.value;
  } catch (error) {
    if (controller.signal.aborted) throw new TextModelError("TEXT_TIMEOUT", 504);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** The three lines for this result and what the person said. Never throws. */
export async function composeWants(result: StoredResult, wants: WantsInput): Promise<WantLines> {
  const plan = wantsPlan(result.code, wants);
  if (!plan.needsModel) return plan.lines;
  const { model, now } = current();
  if (!model) return plan.lines;
  if (!takeSlot(dailyLimit(process.env, "ASSESS_TEXT_DAILY_LIMIT", DEFAULT_TEXT_DAILY_LIMIT), now(), "text")) {
    console.warn(JSON.stringify({ event: "wants.skipped", resultId: result.id, reason: "daily_budget" }));
    return plan.lines;
  }
  const started = Date.now();
  try {
    const lines = await askModel(model, result, wants);
    console.info(JSON.stringify({ event: "wants.model_ready", resultId: result.id, model: model.label, seconds: Math.round((Date.now() - started) / 1000) }));
    return lines;
  } catch (error) {
    console.warn(JSON.stringify({ event: "wants.model_failed", resultId: result.id, model: model.label, fallback: plan.lines.source,
      ...(error instanceof TextModelError ? { status: error.status } : {}),
      reason: error instanceof Error ? error.message.slice(0, 200) : "unknown" }));
    return plan.lines;
  }
}
