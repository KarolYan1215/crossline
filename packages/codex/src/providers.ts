import { capabilityGap, SKILL_NEEDS, skillKey, tFor, THIRD_PARTY_CAPABILITIES, type Locale, type ProviderCapabilities } from "@crossline/core";
import { runLocale } from "./style";
import type { SkillTools } from "./skill-runner";
import { currentUsageWorkspace } from "./usage";

/**
 * Model providers other than the workspace's own Codex sign-in (R7, docs/review-2026-10-13.md §7, decided 2026-10-13). Every one of
 * them runs through the same Codex app-server path — threads, the repair loop, the validators, usage events — with Codex pointed at
 * the local model gateway (`model-gateway.ts`) for this one thread. What a provider may serve is its capabilities (fixed) and its
 * conformance result (measured), never its own claims.
 *
 * One provider per workspace, stored without its key as the `model.provider` setting; the key is a DPAPI file the worker reads.
 */
export type ProviderKind =
  /** A Chat-Completions-only endpoint, translated by the gateway. */
  | "chat"
  /** A native Responses endpoint, passed through by the gateway. */
  | "responses"
  /** Sign in with ChatGPT plan sharing: OpenAI's Responses endpoint with the plan token the sign-in left as this workspace's key. */
  | "siwc-plan";

export type ProviderConfig = {
  id: string;
  kind: ProviderKind;
  label: string;
  /** Everything before `/responses` or `/chat/completions`. https, or http on a loopback address (a local model). */
  baseUrl: string;
  /** One model for every Skill: conformance is measured on it, so a second model would be a second, unmeasured provider. */
  model: string;
  /** Chat only: `json_object` for a provider without JSON-schema output (the schema then goes in the instructions). */
  responseFormat?: "json_schema" | "json_object";
  /** The last four characters of the key the worker holds, or null for a provider that takes none. Never the key. */
  keyLast4: string | null;
  updatedAt: string;
};
export const MODEL_PROVIDER_SETTING = "model.provider";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
export const isLocalProvider = (baseUrl: string) => { try { return LOOPBACK.has(new URL(baseUrl).hostname); } catch { return false; } };

/** Why a provider configuration cannot be saved, in words the person reads; undefined when it can. */
export function providerConfigProblem(config: Pick<ProviderConfig, "id" | "kind" | "baseUrl" | "model" | "label">, locale?: Locale): string | undefined {
  const t = tFor(locale);
  if (!/^[a-z0-9-]{1,32}$/.test(config.id)) return t("名称只能用小写字母、数字和连字符。");
  if (!["chat", "responses", "siwc-plan"].includes(config.kind)) return t("接口类型不认识。");
  if (!config.label.trim() || config.label.length > 40) return t("请填一个 40 字以内的显示名称。");
  let url: URL;
  try { url = new URL(config.baseUrl); } catch { return t("接口地址不是一个网址。"); }
  if (url.username || url.password || url.search || url.hash) return t("接口地址里不能带账号、参数或 #。");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) return t("接口地址必须是 https；只有本机模型（127.0.0.1）可以用 http。");
  if (!config.model || config.model.length > 120 || /\s/.test(config.model)) return t("请填写模型名（不含空格）。");
  return undefined;
}

/** What one run needs to know about the workspace's provider, as the worker resolves it (`setProviderResolver`). */
export type ProviderRouting = {
  provider: ProviderConfig;
  /** The gateway route Codex is given as `base_url` for this provider. */
  gatewayUrl: string;
  /** The Skills the provider's current conformance record admits (empty until it has been tested, or once the record is stale). */
  admitted: ReadonlySet<string>;
  /** Whether the workspace also has its own Codex sign-in, which serves what the provider cannot. Never the machine owner's runtime. */
  codexSignedIn: boolean;
  /**
   * What Crossline itself adds on top of the provider (docs/beta-launch.md §10.4): web search when a search API is configured, image
   * generation when an image API is. Unset means the fixed third-party set.
   */
  capabilities?: Partial<ProviderCapabilities>;
  /** The search functions that stand in for hosted web search on this provider (set exactly when `capabilities.webSearch` is). */
  webTools?: SkillTools;
};

let resolver: ((workspaceId: string | undefined) => ProviderRouting | undefined) | undefined;
/** Installed once by the worker; with none installed every run keeps the Codex sign-in it always had. */
export function setProviderResolver(next: ((workspaceId: string | undefined) => ProviderRouting | undefined) | undefined): void { resolver = next; }
export function currentProviderRouting(): ProviderRouting | undefined {
  try { return resolver?.(currentUsageWorkspace()); } catch { return undefined; }
}
/** Where a run of this Skill would go for the current workspace, for callers that act outside a model turn (the portrait figure). */
export const currentRoute = (skillName: string): RouteDecision => decideRoute(skillName, currentProviderRouting());

/** What Codex is given for one thread: the provider's id and its definition (no key — the gateway adds it). */
export type ThreadProvider = { id: string; model: string; definition: Record<string, unknown> };
export type RouteDecision = { via: "codex" } | { via: "provider"; provider: ThreadProvider }
  | { via: "blocked"; code: "MODEL_CAPABILITY_MISSING" | "MODEL_NOT_ADMITTED"; message: string };

export function threadProvider(routing: Pick<ProviderRouting, "provider" | "gatewayUrl">, model: string): ThreadProvider {
  return { id: `crossline-${routing.provider.id}`, model, definition: {
    name: routing.provider.label, base_url: routing.gatewayUrl, wire_api: "responses", requires_openai_auth: false, supports_websockets: false,
    // A local model can think for minutes before its first word; the gateway streams its reasoning, but leave room.
    stream_idle_timeout_ms: 600_000, request_max_retries: 2, stream_max_retries: 2 } };
}

/**
 * Where one run of a Skill goes, in the order the review set (§7.2): the workspace's provider when it can do what the Skill needs and
 * its conformance admits the Skill; else the workspace's own Codex sign-in; else a blocker that says why, which the caller turns into
 * an ask. There is never a third option — a workspace that has neither does not borrow the machine owner's runtime.
 */
export function decideRoute(skillName: string, routing: ProviderRouting | undefined, locale?: Locale): RouteDecision {
  if (!routing) return { via: "codex" };
  // The blocker is shown to the person: in the run's language (the workspace's, unless the caller names one).
  const language = locale ?? runLocale(undefined, currentUsageWorkspace());
  const t = tFor(language);
  const key = skillKey(skillName);
  const gap = capabilityGap(key, { ...THIRD_PARTY_CAPABILITIES, ...routing.capabilities }, language);
  if (!gap && routing.admitted.has(key)) return { via: "provider", provider: threadProvider(routing, routing.provider.model) };
  if (routing.codexSignedIn) return { via: "codex" };
  const label = t(SKILL_NEEDS[key]?.label ?? "这项功能");
  return gap ? { via: "blocked", code: "MODEL_CAPABILITY_MISSING", message: gap }
    : { via: "blocked", code: "MODEL_NOT_ADMITTED", message: t("{{feature}}还没有交给「{{provider}}」：它还没通过这项功能的检验。到 设置 → 模型连接 运行检验，或登录 ChatGPT。", { feature: label, provider: routing.provider.label }) };
}
