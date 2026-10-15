import { createHash } from "node:crypto";
import { publicHttpsUrl } from "@crossline/core";
import { resolvesPublicly } from "./diligence";

/**
 * Fetching a page the model named, from this person's machine.
 *
 * A model-supplied address is untrusted input: it may not be a way to make this computer call something on its own
 * network, to pull down something enormous, or to save something that is not what it was said to be. So the request
 * is made only to a public https host (checked again at every redirect, with a DNS lookup so a name cannot lead to
 * a private address), the body is read with a hard size cap, and the content type must be one of a short list.
 */
export type SafeGetDeps = {
  fetchImpl: typeof fetch;
  isPublicHost: (host: string) => Promise<boolean>;
};
export const defaultSafeGetDeps = (): SafeGetDeps => ({ fetchImpl: fetch, isPublicHost: resolvesPublicly });

export type SafeGetResult =
  | { ok: true; finalUrl: string; status: number; contentType: string; bytes: Uint8Array; sha256: string }
  | { ok: false; reason: string };

const ALLOWED_TYPES = ["application/pdf", "text/html", "application/xhtml+xml", "text/plain", "text/markdown"];

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array | undefined> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) return undefined;
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(await response.arrayBuffer()).slice(0, maxBytes);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { void reader.cancel(); return undefined; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

export async function safeGet(address: string, deps: SafeGetDeps, options: { maxBytes: number; timeoutMs?: number;
  /** Content types accepted instead of the page types (a calendar subscription reads `text/calendar`). */
  types?: string[] }): Promise<SafeGetResult> {
  const allowed = options.types ?? ALLOWED_TYPES;
  let url = publicHttpsUrl(address);
  for (let hop = 0; hop < 4; hop += 1) {
    if (!url) return { ok: false, reason: "地址不是公开的 https 页面" };
    if (!(await deps.isPublicHost(url.hostname))) return { ok: false, reason: "域名解析到非公开地址" };
    let response: Response;
    try {
      response = await deps.fetchImpl(url.toString(), {
        redirect: "manual", signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
        headers: { "user-agent": "Crossline/1.0 (personal research; local)", accept: allowed.join(",") }
      });
    } catch { return { ok: false, reason: "打不开" }; }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      try { url = location ? publicHttpsUrl(new URL(location, url).toString()) : undefined; } catch { url = undefined; }
      continue;
    }
    if (response.status < 200 || response.status >= 300) return { ok: false, reason: `返回 ${response.status}` };
    const contentType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!allowed.includes(contentType)) return { ok: false, reason: `内容类型 ${contentType || "未知"} 不在允许范围内` };
    let bytes: Uint8Array | undefined;
    try { bytes = await readCapped(response, options.maxBytes); } catch { return { ok: false, reason: "读取中断" }; }
    if (!bytes) return { ok: false, reason: `超过 ${Math.round(options.maxBytes / 1_000_000)} MB 上限` };
    return { ok: true, finalUrl: url.toString(), status: response.status, contentType, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  return { ok: false, reason: "跳转过多" };
}

/** arXiv's abstract page is a web page; the paper itself is at `/pdf/<id>`. */
export function arxivPdfAddress(address: string): string {
  const url = publicHttpsUrl(address);
  const match = url && /(^|\.)arxiv\.org$/.test(url.hostname) ? /^\/abs\/(.+)$/.exec(url.pathname) : null;
  return match ? `https://arxiv.org/pdf/${match[1]}` : address;
}

/** The readable text of a downloaded page, without markup, scripts or styles. */
export function htmlToText(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/(p|div|li|h\d|tr|br)>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}
