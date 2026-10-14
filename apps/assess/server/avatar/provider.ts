/**
 * The image model behind the figures (docs/beta-launch.md §4, "SiliconFlow 接口与做法"). One interface, two uses: `edit` draws a
 * person's figure from their type's template (FLUX.1 Kontext [dev], image + instruction), `generate` drafts template candidates
 * (text only, `scripts/assess-templates.ts`). The provider is chosen from the environment; with no key there is none, and every figure
 * settles on its template at once.
 */

export type EditInput = { reference: Buffer; prompt: string; seed: number; signal?: AbortSignal };
export type GenerateInput = { prompt: string; seed: number; signal?: AbortSignal };

export interface ImageProvider {
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

/** The provider the environment names: none without `ASSESS_IMAGE_API_KEY`. */
export function providerFromEnv(env: Record<string, string | undefined> = process.env): ImageProvider | null {
  const apiKey = env.ASSESS_IMAGE_API_KEY?.trim();
  if (!apiKey) return null;
  return new SiliconFlowProvider({
    apiKey,
    ...(env.ASSESS_IMAGE_BASE_URL ? { baseUrl: env.ASSESS_IMAGE_BASE_URL } : {}),
    ...(env.ASSESS_IMAGE_MODEL ? { editModel: env.ASSESS_IMAGE_MODEL } : {}),
    ...(env.ASSESS_IMAGE_TEMPLATE_MODEL ? { generateModel: env.ASSESS_IMAGE_TEMPLATE_MODEL } : {})
  });
}
