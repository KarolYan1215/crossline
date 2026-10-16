/**
 * The image model behind the figures (docs/beta-launch.md §4, "SiliconFlow 接口与做法"). One interface, two uses: `edit` draws a
 * person's figure from their type's template (FLUX.1 Kontext [dev], image + instruction), `generate` drafts template candidates
 * (text only, `scripts/assess-templates.ts`). The provider is chosen from the environment; with no key there is none, and every figure
 * settles on its template at once.
 */

/** Filled in as a call goes: when the service answered (the picture made) and how many bytes came back, so a slow call says which part was slow. */
export type CallTiming = { answeredAt?: number; bytes?: number };
export type EditInput = { reference: Buffer; prompt: string; seed: number; signal?: AbortSignal; timing?: CallTiming };
export type GenerateInput = { prompt: string; seed: number; signal?: AbortSignal };

export interface ImageProvider {
  /** Which service and model this is, for the server log (never the key). */
  readonly label?: string;
  edit(input: EditInput): Promise<Buffer>;
  generate(input: GenerateInput): Promise<Buffer>;
}

/** A refusal from the image API; `status` decides whether one retry is worth it (429 and 5xx are). */
export class ProviderError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterMs?: number) {
    super(message);
    this.name = "ProviderError";
  }
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export const DEFAULT_EDIT_MODEL = "black-forest-labs/FLUX.1-Kontext-dev";
/** Kontext [dev] requires an input image, so template candidates are drafted with a text-to-image model. */
export const DEFAULT_GENERATE_MODEL = "black-forest-labs/FLUX.1-dev";
export const DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1";
/** The largest image we accept from the provider's download link. */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
/** The API takes seeds 0–9999999999. */
export const MAX_SEED = 9_999_999_999;

type Fetch = typeof fetch;

/** `Retry-After` in seconds or as an HTTP date, in ms; none when absent or unreadable. */
export function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** PNG, JPEG or WebP by their first bytes; anything else is not an image we store. */
export function imageType(bytes: Buffer): "image/png" | "image/jpeg" | "image/webp" | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/**
 * Fetches the image the API linked to (valid for one hour). Only https at every hop (at most three redirects), no credentials in the
 * address, at most `MAX_IMAGE_BYTES`, and the bytes must be an image; the API key is never sent to it.
 */
export async function downloadImage(url: string, fetchImpl: Fetch = fetch, signal?: AbortSignal): Promise<Buffer> {
  let address = url;
  let response: Response | undefined;
  for (let hop = 0; hop <= 3; hop += 1) {
    let parsed: URL;
    try { parsed = new URL(address); } catch { throw new ProviderError("IMAGE_URL_INVALID", 502); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new ProviderError("IMAGE_URL_NOT_HTTPS", 502);
    response = await fetchImpl(parsed, { redirect: "manual", ...(signal ? { signal } : {}) });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (!location) break;
    address = new URL(location, parsed).toString();
    response = undefined;
  }
  if (!response) throw new ProviderError("IMAGE_TOO_MANY_REDIRECTS", 502);
  if (!response.ok) throw new ProviderError(`IMAGE_DOWNLOAD_${response.status}`, response.status >= 500 ? 502 : 400);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_IMAGE_BYTES) throw new ProviderError("IMAGE_TOO_LARGE", 502);
  if (!response.body) throw new ProviderError("IMAGE_EMPTY", 502);
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_IMAGE_BYTES) {
      await reader.cancel();
      throw new ProviderError("IMAGE_TOO_LARGE", 502);
    }
    chunks.push(Buffer.from(value));
  }
  const bytes = Buffer.concat(chunks);
  if (!imageType(bytes)) throw new ProviderError("IMAGE_NOT_AN_IMAGE", 502);
  return bytes;
}

export type SiliconFlowOptions = { apiKey: string; baseUrl?: string; editModel?: string; generateModel?: string; fetchImpl?: Fetch };

/**
 * SiliconFlow's `POST /images/generations`: Bearer key, JSON body, the reference as a `data:image/png;base64,…` string in `image`
 * (Kontext [dev]), `prompt_enhancement: false` so our fixed instruction reaches the model unchanged, and `{ images: [{ url }] }` back.
 */
export class SiliconFlowProvider implements ImageProvider {
  readonly label: string;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #editModel: string;
  readonly #generateModel: string;
  readonly #fetch: Fetch;

  constructor(options: SiliconFlowOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    if (!this.#baseUrl.startsWith("https://")) throw new Error("ASSESS_IMAGE_BASE_URL must be https");
    this.#editModel = options.editModel ?? DEFAULT_EDIT_MODEL;
    this.label = `siliconflow:${this.#editModel}`;
    this.#generateModel = options.generateModel ?? DEFAULT_GENERATE_MODEL;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async edit(input: EditInput): Promise<Buffer> {
    const type = imageType(input.reference) ?? "image/png";
    return this.#request({ model: this.#editModel, prompt: input.prompt, seed: clampSeed(input.seed), prompt_enhancement: false,
      image: `data:${type};base64,${input.reference.toString("base64")}` }, input.signal);
  }

  async generate(input: GenerateInput): Promise<Buffer> {
    return this.#request({ model: this.#generateModel, prompt: input.prompt, seed: clampSeed(input.seed), image_size: "1024x1024",
      num_inference_steps: 28, prompt_enhancement: false }, input.signal);
  }

  async #request(body: Record<string, unknown>, signal?: AbortSignal): Promise<Buffer> {
    const response = await this.#fetch(`${this.#baseUrl}/images/generations`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.#apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {})
    });
    if (!response.ok) {
      // The body names the cause (a model id, a rate limit); it never carries the key, but keep it short in logs.
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      throw new ProviderError(`IMAGE_API_${response.status}: ${detail}`, response.status, retryAfterMs(response.headers.get("retry-after")));
    }
    const json = await response.json().catch(() => null) as { images?: Array<{ url?: unknown }> } | null;
    const url = json?.images?.[0]?.url;
    if (typeof url !== "string") throw new ProviderError("IMAGE_API_NO_URL", 502);
    return downloadImage(url, this.#fetch, signal);
  }
}

const clampSeed = (seed: number): number => Math.max(0, Math.min(MAX_SEED, Math.floor(seed)));

export const ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
/** The Seedream model the owner's Ark account has open (the App's portrait figure uses the same one). */
export const ARK_DEFAULT_MODEL = "doubao-seedream-5-0-pro-260628";
/** The template's own 2:3 shape (1024×1536, 1.57 MP): inside the pixel range of Seedream 4.0 and 5.0 pro/flash ([0.92 MP, 4.62 MP]). */
export const ARK_SIZE_SMALL = "1024x1536";
/** 2:3 at 4.15 MP: Seedream 4.5 and 5.0 lite refuse anything under 2560×1440 (3.69 MP), and this one also fits 5.0 pro's ceiling. */
export const ARK_SIZE_LARGE = "1664x2496";

/**
 * The output size for a Seedream model (docs.volcengine.com/docs/82379/1541523, 「size」, read 2026-10-16): 4.0 and 5.0 pro/flash take
 * 0.92–4.62 MP (4.0 up to 16.7 MP), 4.5 and 5.0 lite take 3.69–16.7 MP. A size outside the model's range is refused at once
 * (InvalidParameter), so a model we cannot place gets the size every version accepts. `ASSESS_IMAGE_SIZE` overrides it.
 */
export function arkSize(model: string, override?: string): string {
  const named = override?.trim();
  if (named && /^(\d{3,4}x\d{3,4}|[1-4](\.5)?K)$/i.test(named)) return /k$/i.test(named) ? named.toUpperCase() : named.toLowerCase();
  if (/seedream-(3-0|4-0)|seedream-5-0-(pro|flash)/i.test(model)) return ARK_SIZE_SMALL;
  return ARK_SIZE_LARGE;
}

/**
 * Volcengine Ark's Seedream (`POST /images/generations`, chosen with `ASSESS_IMAGE_PROVIDER=ark`; tried 2026-10-16 after SiliconFlow's
 * Qwen-Image-Edit drew poorly): the same call edits (with the template as `image`, a lowercase `data:image/png;base64,…` URL, at most
 * 30 MB) and generates (without), the platform's own 「AI 生成」 mark is turned off (`watermark: false`), and the link it returns (valid 24
 * hours) is fetched at once without the key. No `seed`: the current API reference lists none for Seedream 4.0 and later (it belonged to
 * 3.0), and a parameter the model does not take is the one thing here that could be refused instead of ignored.
 */
export class ArkProvider implements ImageProvider {
  readonly label: string;
  readonly size: string;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #fetch: Fetch;

  constructor(options: { apiKey: string; baseUrl?: string; model?: string; size?: string; fetchImpl?: Fetch }) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? ARK_BASE_URL).replace(/\/+$/, "");
    if (!this.#baseUrl.startsWith("https://")) throw new Error("ASSESS_IMAGE_BASE_URL must be https");
    this.#model = options.model ?? ARK_DEFAULT_MODEL;
    this.size = arkSize(this.#model, options.size);
    this.label = `ark:${this.#model}`;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async edit(input: EditInput): Promise<Buffer> {
    const type = imageType(input.reference) ?? "image/png";
    return this.#request({ prompt: input.prompt, image: `data:${type};base64,${input.reference.toString("base64")}` }, input.signal, input.timing);
  }

  async generate(input: GenerateInput): Promise<Buffer> {
    return this.#request({ prompt: input.prompt }, input.signal);
  }

  async #request(body: Record<string, unknown>, signal?: AbortSignal, timing?: CallTiming): Promise<Buffer> {
    const response = await this.#fetch(`${this.#baseUrl}/images/generations`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.#apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: this.#model, size: this.size, response_format: "url", watermark: false, ...body }),
      ...(signal ? { signal } : {})
    });
    if (!response.ok) {
      // Ark answers `{error: {code, message}}`; the code (ModelNotOpen, InvalidParameter, AuthenticationError…) goes first in the log.
      const text = await response.text().catch(() => "");
      throw new ProviderError(`IMAGE_API_${response.status}: ${arkErrorSummary(text)}`, response.status, retryAfterMs(response.headers.get("retry-after")));
    }
    const json = await response.json().catch(() => null) as { data?: Array<{ url?: unknown; error?: { code?: unknown; message?: unknown } }>; error?: unknown } | null;
    const first = json?.data?.[0];
    const url = first?.url;
    if (typeof url !== "string") {
      // A 200 can still carry a per-image refusal (e.g. the content check), with no url.
      const reason = first?.error ? arkErrorSummary(JSON.stringify({ error: first.error })) : json?.error ? arkErrorSummary(JSON.stringify(json)) : "";
      throw new ProviderError(`IMAGE_API_NO_URL${reason ? `: ${reason}` : ""}`, 502);
    }
    if (timing) timing.answeredAt = Date.now();
    const bytes = await downloadImage(url, this.#fetch, signal);
    if (timing) timing.bytes = bytes.length;
    return bytes;
  }
}

/** `code: message` from an Ark error body, else the body itself, at most 200 characters. Never carries the key. */
export function arkErrorSummary(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
    const code = typeof parsed.error?.code === "string" ? parsed.error.code : "";
    const message = typeof parsed.error?.message === "string" ? parsed.error.message : "";
    if (code || message) return `${code}${code && message ? ": " : ""}${message}`.slice(0, 200);
  } catch { /* not JSON */ }
  return text.slice(0, 200);
}

/** The image services `ASSESS_IMAGE_PROVIDER` may name. */
export const IMAGE_PROVIDERS = ["siliconflow", "ark"] as const;
type ProviderName = (typeof IMAGE_PROVIDERS)[number];

/** Other names people write for Volcengine Ark; all mean `ark`. */
// i18n-ignore: names an operator may write in the environment
const ARK_ALIASES = ["ark", "volcengine", "volces", "volcano", "doubao", "seedream", "byteplus", "火山", "火山方舟", "方舟", "豆包"];

/**
 * Which service the environment means, and how that was decided. Named: `ark` (or one of its other names) or `siliconflow`. Unset or
 * empty — an env file with `ASSESS_IMAGE_PROVIDER=` and nothing after it counts as unset — it is read off the key and the base URL:
 * SiliconFlow keys start with `sk-`, Ark keys do not (they are UUIDs), and a `volces.com`/`byteplus` base URL is Ark. A name it does not
 * know gives none rather than sending the key to the wrong service.
 */
export function providerChoice(env: Record<string, string | undefined>): { name: ProviderName | null; how: "named" | "inferred" | "unknown" } {
  const named = env.ASSESS_IMAGE_PROVIDER?.trim().toLowerCase() || "";
  if (named) {
    if (ARK_ALIASES.includes(named)) return { name: "ark", how: "named" };
    // i18n-ignore: an environment value
    if (named === "siliconflow" || named === "硅基流动") return { name: "siliconflow", how: "named" };
    return { name: null, how: "unknown" };
  }
  const baseUrl = env.ASSESS_IMAGE_BASE_URL?.trim() ?? "";
  if (/volces\.com|byteplus/i.test(baseUrl)) return { name: "ark", how: "inferred" };
  if (/siliconflow/i.test(baseUrl)) return { name: "siliconflow", how: "inferred" };
  return { name: env.ASSESS_IMAGE_API_KEY?.trim().startsWith("sk-") ? "siliconflow" : "ark", how: "inferred" };
}

/** A SiliconFlow model id (`org/name`) is never an Ark model; sent to Ark it is refused with a 404 on every call. */
const arkModelFrom = (model: string | undefined): string | undefined => (model && !model.includes("/") ? model : undefined);

/**
 * The provider the environment names (`providerChoice`): none without `ASSESS_IMAGE_API_KEY` or with a provider name it does not know.
 * `avatar.provider` in the server log says which one was chosen, or why none was.
 */
export function providerFromEnv(env: Record<string, string | undefined> = process.env): ImageProvider | null {
  const apiKey = env.ASSESS_IMAGE_API_KEY?.trim();
  if (!apiKey) return null;
  const { name } = providerChoice(env);
  const baseUrl = env.ASSESS_IMAGE_BASE_URL?.trim();
  const model = env.ASSESS_IMAGE_MODEL?.trim();
  if (name === "ark") {
    const arkModel = arkModelFrom(model);
    const size = env.ASSESS_IMAGE_SIZE?.trim();
    return new ArkProvider({ apiKey, ...(baseUrl ? { baseUrl } : {}), ...(arkModel ? { model: arkModel } : {}), ...(size ? { size } : {}) });
  }
  if (name !== "siliconflow") return null;
  const templateModel = env.ASSESS_IMAGE_TEMPLATE_MODEL?.trim();
  return new SiliconFlowProvider({
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    ...(model ? { editModel: model } : {}),
    ...(templateModel ? { generateModel: templateModel } : {})
  });
}

/**
 * What the server log says about the image settings at start: the provider chosen, its model and size, or the reason there is none, and
 * a note for anything the environment said that was not used as written. Never the key.
 */
export function providerSummary(env: Record<string, string | undefined> = process.env): { provider: string; model?: string; size?: string; reason?: string } {
  if (!env.ASSESS_IMAGE_API_KEY?.trim()) return { provider: "none", reason: "ASSESS_IMAGE_API_KEY unset or empty: every figure is the fallback" };
  const choice = providerChoice(env);
  if (!choice.name) {
    const named = env.ASSESS_IMAGE_PROVIDER?.trim().toLowerCase() ?? "";
    return { provider: "none", reason: `ASSESS_IMAGE_PROVIDER=${named.slice(0, 40)} is not one of ${IMAGE_PROVIDERS.join(", ")}` };
  }
  const provider = providerFromEnv(env);
  const [service, model] = (provider?.label ?? "none").split(/:(.*)/s);
  const notes: string[] = [];
  if (choice.how === "inferred") notes.push(`ASSESS_IMAGE_PROVIDER unset or empty: ${choice.name} read off the key and base URL`);
  const given = env.ASSESS_IMAGE_MODEL?.trim();
  if (choice.name === "ark" && given && !arkModelFrom(given)) notes.push(`ASSESS_IMAGE_MODEL=${given.slice(0, 60)} is not an Ark model id: using ${ARK_DEFAULT_MODEL}`);
  if (choice.name === "ark" && !given) notes.push(`ASSESS_IMAGE_MODEL unset or empty: using ${ARK_DEFAULT_MODEL}`);
  return { provider: service!, ...(model ? { model } : {}), ...(provider instanceof ArkProvider ? { size: provider.size } : {}),
    ...(notes.length ? { reason: notes.join("; ") } : {}) };
}
