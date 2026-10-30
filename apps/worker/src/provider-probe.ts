import { isLocalProvider, type ProviderConfig } from "@crossline/codex";
import { tFor, type Locale } from "@crossline/core";
import { resolvesPublicly } from "./diligence";

/**
 * One connection before a provider is saved (2026-10-30): the person learns at once that the address, the key, the model and the balance
 * work, in words — not twenty minutes later from a conformance run where every case fails the same way. Built for OpenAI-compatible
 * relays (中转站) above all, whose errors are the usual four: a wrong key (401), a base URL without `/v1` (404, or the relay's web page),
 * a model name the relay does not carry, no balance left.
 *
 * The model list is read first (it names what the relay carries, for the suggestion), then one smallest real request: only that proves the
 * model answers and the balance holds. Nothing here follows a redirect or contacts a name that resolves to a private address, and the key
 * never appears in what comes back: an upstream that echoes it has it masked.
 */
export type ProbeDeps = { fetchImpl: typeof fetch; isPublicHost: (host: string) => Promise<boolean> };
export const defaultProbeDeps = (): ProbeDeps => ({ fetchImpl: fetch, isPublicHost: resolvesPublicly });

export type ProbeResult = { ok: true } | { ok: false; code: string; message: string };
type Target = Pick<ProviderConfig, "kind" | "baseUrl" | "model">;

const TIMEOUT_MS = 30_000;

/** Upstream text as it may be shown: the key and anything shaped like a key masked, one line, short. */
export function maskedSnippet(text: string, key: string | undefined): string {
  let out = text.replace(/\s+/g, " ").trim();
  if (key) out = out.split(key).join(`···${key.slice(-4)}`);
  out = out.replace(/\b(sk|ak|key)-[A-Za-z0-9_-]{8,}/g, (match) => `${match.slice(0, 3)}···${match.slice(-4)}`);
  return out.length > 160 ? `${out.slice(0, 160)}…` : out;
}

/** The upstream's own message from a JSON error body (`{error:{message}}`, `{message}`, `{msg}`), else the raw text. */
function upstreamMessage(text: string): string {
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown; msg?: unknown };
    const message = typeof body.error === "string" ? body.error : body.error?.message ?? body.message ?? body.msg;
    if (typeof message === "string" && message.trim()) return message;
  } catch { /* not JSON */ }
  return text;
}

/** Model ids the relay names that look like what was typed: same family first, at most five. */
function similarModels(listed: string[], typed: string): string[] {
  const lower = typed.toLowerCase();
  const stem = lower.split(/[-/:]/)[0] ?? lower;
  return listed.filter((id) => id.toLowerCase().includes(stem) || lower.includes(id.toLowerCase())).slice(0, 5);
}

const BALANCE = /insufficient|quota|balance|credit|余额|额度|欠费|充值|billing/i;
const MODEL_WORDS = /model|模型|渠道|channel|deployment/i;

export async function probeProvider(target: Target, key: string | undefined, deps: ProbeDeps, locale?: Locale): Promise<ProbeResult> {
  const t = tFor(locale);
  const base = target.baseUrl.replace(/\/+$/, "");
  const url = new URL(base);
  if (!isLocalProvider(base) && !(await deps.isPublicHost(url.hostname))) {
    return { ok: false, code: "PROVIDER_ADDRESS_PRIVATE", message: t("这个域名解析到内网或本机地址，不能使用。请填写中转站或模型服务的公网地址。") };
  }
  const headers: Record<string, string> = { accept: "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) };
  const send = (path: string, init: RequestInit = {}) => deps.fetchImpl(`${base}/${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
    redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  const noV1 = !/\/v\d+[a-z]*$/i.test(url.pathname);
  const pathHint = noV1 ? t("base URL 通常以 /v1 结尾，例如 https://中转站域名/v1。") : t("请对照中转站后台给出的 API 地址。");

  let listed: string[] = [];
  try {
    const answer = await send("models");
    if (answer.status === 401 || answer.status === 403) return keyInvalid(answer.status, await answer.text().catch(() => ""));
    if (answer.ok) {
      const body = await answer.json().catch(() => undefined) as { data?: Array<{ id?: unknown }> } | undefined;
      listed = (body?.data ?? []).map((item) => item.id).filter((id): id is string => typeof id === "string");
    }
  } catch { return { ok: false, code: "PROVIDER_UNREACHABLE", message: t("连不上这个地址：域名写错，或这个服务已停用。") }; }

  const body = target.kind === "chat"
    ? { model: target.model, messages: [{ role: "user", content: "Reply with OK." }], stream: false }
    : { model: target.model, input: "Reply with OK.", max_output_tokens: 16 };
  let answer: Response;
  try {
    answer = await send(target.kind === "chat" ? "chat/completions" : "responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch { return { ok: false, code: "PROVIDER_UNREACHABLE", message: t("连不上这个地址：域名写错，或这个服务已停用。") }; }
  const text = await answer.text().catch(() => "");
  const said = maskedSnippet(upstreamMessage(text), key);
  if (answer.status >= 300 && answer.status < 400) return { ok: false, code: "PROVIDER_REDIRECT", message: t("这个地址把请求转去了别处。{{hint}}", { hint: pathHint }) };
  if (answer.status === 401 || answer.status === 403) return keyInvalid(answer.status, text);
  if (answer.ok) {
    const type = answer.headers.get("content-type") ?? "";
    if (/text\/html/i.test(type) || /^\s*</.test(text)) return { ok: false, code: "PROVIDER_PATH_WRONG", message: t("这个地址返回的是网页，不是接口。{{hint}}", { hint: pathHint }) };
    return { ok: true };
  }
  if (answer.status === 402 || BALANCE.test(said)) return { ok: false, code: "PROVIDER_BALANCE", message: t("余额或额度不足：先到服务后台充值，再保存。（对方原话：{{said}}）", { said }) };
  const modelUnknown = MODEL_WORDS.test(said) && (answer.status === 400 || answer.status === 404 || answer.status === 422 || answer.status === 503);
  if (modelUnknown || (listed.length > 0 && !listed.includes(target.model) && answer.status < 500)) {
    const like = similarModels(listed, target.model);
    return { ok: false, code: "PROVIDER_MODEL_UNKNOWN", message: like.length
      ? t("这个服务没有模型「{{model}}」。它提供的相近模型：{{like}}。", { model: target.model, like: like.join("、") })
      : t("这个服务没有模型「{{model}}」，请对照服务后台的模型列表填写。（对方原话：{{said}}）", { model: target.model, said }) };
  }
  if (answer.status === 404) return { ok: false, code: "PROVIDER_PATH_WRONG", message: t("这个地址下没有找到接口（404）。{{hint}}", { hint: pathHint }) };
  // Refused for load: the address, key and model are right; the conformance run waits such refusals out.
  if (answer.status === 429) return { ok: true };
  return { ok: false, code: "PROVIDER_UPSTREAM_ERROR", message: t("服务返回 {{status}}：{{said}}", { status: answer.status, said: said || t("没有说明") }) };

  function keyInvalid(status: number, raw: string): ProbeResult {
    const detail = maskedSnippet(upstreamMessage(raw), key);
    return BALANCE.test(detail)
      ? { ok: false, code: "PROVIDER_BALANCE", message: t("余额或额度不足：先到服务后台充值，再保存。（对方原话：{{said}}）", { said: detail }) }
      : { ok: false, code: "PROVIDER_KEY_INVALID", message: t("API key 无效（{{status}}）：复制不全、已删除，或不属于这个地址。", { status }) };
  }
}
