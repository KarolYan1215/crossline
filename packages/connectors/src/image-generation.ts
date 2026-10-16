/**
 * Text-to-image for runs on a model provider other than the person's own Codex sign-in (docs/beta-launch.md §10.4): the portrait
 * figure is drawn by an image model directly, from the prompt `characterPrompt` already builds, with no language model in between.
 *
 * Three request styles behind one `/images/generations` path:
 * - `siliconflow`: `{model, prompt, image_size, prompt_enhancement}` → `{images: [{url}]}` (FLUX, Qwen-Image, Kolors on SiliconFlow);
 * - `openai`: `{model, prompt, size, n}` → `{data: [{url | b64_json}]}` (OpenAI);
 * - `ark`: Volcengine Ark's Seedream, `{model, prompt, size, response_format: "url", watermark: false}` → `{data: [{url}]}` — the same
 *   service and key the public test draws its figures with (decided 2026-10-16), full length 2:3 by default, without the platform's
 *   「AI 生成」 mark. Picked by `CROSSLINE_IMAGE_API_STYLE=ark` or a `volces.com` base URL.
 *
 * From the environment: `CROSSLINE_IMAGE_API_KEY` (else `SILICONFLOW_API_KEY`), `CROSSLINE_IMAGE_BASE_URL` (default SiliconFlow's
 * mainland address), `CROSSLINE_IMAGE_MODEL`, `CROSSLINE_IMAGE_SIZE`, `CROSSLINE_IMAGE_API_STYLE`. No key, no backend.
 * The download checks match `apps/assess/server/avatar/provider.ts`: links are https at every hop, capped, and must be an image.
 */
export interface ImageBackend {
  readonly id: string;
  readonly model: string;
  generate(prompt: string, options?: { seed?: number; signal?: AbortSignal }): Promise<Buffer>;
}

type Fetch = typeof fetch;
/** Volcengine Ark's mainland endpoint and the Seedream model the public test uses. */
export const ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
export const ARK_DEFAULT_MODEL = "doubao-seedream-5-0-pro-260628";
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export function imageType(bytes: Buffer): "image/png" | "image/jpeg" | "image/webp" | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

async function download(url: string, fetchImpl: Fetch, signal?: AbortSignal): Promise<Buffer> {
  let address = url;
  for (let hop = 0; hop <= 3; hop += 1) {
    const parsed = new URL(address);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("IMAGE_URL_NOT_HTTPS");
    const response = await fetchImpl(parsed, { redirect: "manual", signal: signal ?? AbortSignal.timeout(60_000) });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (location) { address = new URL(location, parsed).toString(); continue; }
    if (!response.ok) throw new Error(`IMAGE_DOWNLOAD_${response.status}`);
    if (Number(response.headers.get("content-length") ?? "0") > MAX_IMAGE_BYTES) throw new Error("IMAGE_TOO_LARGE");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error("IMAGE_TOO_LARGE");
    if (!imageType(bytes)) throw new Error("IMAGE_NOT_AN_IMAGE");
    return bytes;
  }
  throw new Error("IMAGE_TOO_MANY_REDIRECTS");
}

export type ImageBackendOptions = { apiKey: string; baseUrl: string; model: string; size: string; style: "siliconflow" | "openai" | "ark"; fetchImpl?: Fetch };

export function imageBackend(options: ImageBackendOptions): ImageBackend {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  if (!baseUrl.startsWith("https://")) throw new Error("CROSSLINE_IMAGE_BASE_URL must be https");
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    id: options.style, model: options.model,
    async generate(prompt, { seed, signal } = {}) {
      const body = options.style === "siliconflow"
        ? { model: options.model, prompt, image_size: options.size, prompt_enhancement: false, ...(seed !== undefined ? { seed } : {}) }
        : options.style === "ark" ? { model: options.model, prompt, size: options.size, response_format: "url", watermark: false, ...(seed !== undefined ? { seed } : {}) }
        : { model: options.model, prompt, size: options.size, n: 1, ...(seed !== undefined ? { seed } : {}) };
      const response = await fetchImpl(`${baseUrl}/images/generations`, { method: "POST",
        headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" }, body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(180_000) });
      if (!response.ok) throw new Error(`IMAGE_API_${response.status}: ${(await response.text().catch(() => "")).slice(0, 200)}`);
      const json = await response.json().catch(() => null) as { images?: Array<{ url?: unknown }>; data?: Array<{ url?: unknown; b64_json?: unknown }> } | null;
      const b64 = json?.data?.[0]?.b64_json;
      if (typeof b64 === "string" && b64) {
        const bytes = Buffer.from(b64, "base64");
        if (!imageType(bytes)) throw new Error("IMAGE_NOT_AN_IMAGE");
        return bytes;
      }
      const url = json?.images?.[0]?.url ?? json?.data?.[0]?.url;
      if (typeof url !== "string") throw new Error("IMAGE_API_NO_URL");
      // The link is valid for about an hour (SiliconFlow): fetch it now, without the key.
      return download(url, fetchImpl, signal);
    }
  };
}

export function imageBackendFromEnv(env: Record<string, string | undefined> = process.env, fetchImpl?: Fetch): ImageBackend | undefined {
  const apiKey = env.CROSSLINE_IMAGE_API_KEY?.trim() || env.SILICONFLOW_API_KEY?.trim();
  if (!apiKey) return undefined;
  const named = env.CROSSLINE_IMAGE_API_STYLE?.trim();
  const ark = named === "ark" || (!named && /volces\.com/i.test(env.CROSSLINE_IMAGE_BASE_URL ?? ""));
  const baseUrl = env.CROSSLINE_IMAGE_BASE_URL?.trim() || (ark ? ARK_BASE_URL : "https://api.siliconflow.cn/v1");
  const style = ark ? "ark" : named === "openai" ? "openai" : named === "siliconflow" || /siliconflow/i.test(baseUrl) ? "siliconflow" : "openai";
  return imageBackend({ apiKey, baseUrl, style,
    model: env.CROSSLINE_IMAGE_MODEL?.trim() || (ark ? ARK_DEFAULT_MODEL : "black-forest-labs/FLUX.1-dev"),
    size: env.CROSSLINE_IMAGE_SIZE?.trim() || (ark ? "1024x1536" : "1024x1024"), ...(fetchImpl ? { fetchImpl } : {}) });
}
