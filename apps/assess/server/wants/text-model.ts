/**
 * The text model behind 「你也许想做」 (2026-10-16): any OpenAI-compatible chat completions endpoint (DeepSeek, Volcengine Ark, Qwen,
 * Kimi, GLM, OpenAI …), named entirely by the environment and off unless all three of `ASSESS_TEXT_API_KEY`, `ASSESS_TEXT_BASE_URL`
 * (https only) and `ASSESS_TEXT_MODEL` are set. Off is a normal state: the lines then come from the rules. Nothing of the private app's
 * models, accounts or ledger is used.
 */

export type ChatMessage = { role: "system" | "user"; content: string };

export interface TextModel {
  /** Service host and model, for the server log (never the key). */
  readonly label: string;
  complete(messages: ChatMessage[], signal?: AbortSignal): Promise<string>;
}

/** A refusal or failure from the text API, with its HTTP status (0 for one that never got an answer). */
export class TextModelError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "TextModelError";
  }
}

type Fetch = typeof fetch;

export type ChatOptions = { apiKey: string; baseUrl: string; model: string; jsonMode?: boolean; fetchImpl?: Fetch };

/**
 * `POST <base>/chat/completions` with a Bearer key: a low temperature, a small token cap (the answer is a few short strings), and
 * `response_format: json_object` unless `ASSESS_TEXT_JSON_MODE=off` (for a provider that refuses the field). Answers the message text.
 */
export class ChatCompletionsModel implements TextModel {
  readonly label: string;
  readonly #options: Required<Omit<ChatOptions, "fetchImpl">> & { fetchImpl: Fetch };

  constructor(options: ChatOptions) {
    const baseUrl = options.baseUrl.replace(/\/+$/, "");
    if (!baseUrl.startsWith("https://")) throw new Error("ASSESS_TEXT_BASE_URL must be https");
    this.#options = { ...options, baseUrl, jsonMode: options.jsonMode ?? true, fetchImpl: options.fetchImpl ?? fetch };
    this.label = `${new URL(baseUrl).host}:${options.model}`;
  }

  async complete(messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
    const { apiKey, baseUrl, model, jsonMode, fetchImpl } = this.#options;
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model, messages, temperature: 0.6, max_tokens: 700, ...(jsonMode ? { response_format: { type: "json_object" } } : {}) }),
        ...(signal ? { signal } : {})
      });
    } catch (error) {
      throw new TextModelError(`TEXT_API_UNREACHABLE: ${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`, 0);
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      throw new TextModelError(`TEXT_API_${response.status}: ${detail}`, response.status);
    }
    const json = await response.json().catch(() => null) as { choices?: Array<{ message?: { content?: unknown } }> } | null;
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new TextModelError("TEXT_API_EMPTY", 502);
    return content;
  }
}

/** The model the environment names, or none (the default: the lines come from the rules). */
export function textModelFromEnv(env: Record<string, string | undefined> = process.env): TextModel | null {
  const apiKey = env.ASSESS_TEXT_API_KEY?.trim();
  const baseUrl = env.ASSESS_TEXT_BASE_URL?.trim();
  const model = env.ASSESS_TEXT_MODEL?.trim();
  if (!apiKey || !baseUrl || !model) return null;
  try {
    return new ChatCompletionsModel({ apiKey, baseUrl, model, jsonMode: env.ASSESS_TEXT_JSON_MODE?.trim().toLowerCase() !== "off" });
  } catch {
    return null;
  }
}

/** What the log says about the text model at start: which one, or why there is none. Never the key. */
export function textModelSummary(env: Record<string, string | undefined> = process.env): { model: string; reason?: string } {
  const missing = ["ASSESS_TEXT_API_KEY", "ASSESS_TEXT_BASE_URL", "ASSESS_TEXT_MODEL"].filter((name) => !env[name]?.trim());
  if (missing.length) return { model: "none", reason: `${missing.join(", ")} unset: 「你也许想做」 uses the written combinations and rules` };
  const model = textModelFromEnv(env);
  return model ? { model: model.label } : { model: "none", reason: "ASSESS_TEXT_BASE_URL must be https" };
}

/** The JSON object in a model's answer: the whole text, or the part inside a ```json fence or between the outer braces. */
export function jsonFromAnswer(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  const candidate = fenced ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return undefined;
  }
}
