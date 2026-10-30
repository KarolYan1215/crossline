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
  /** The model's context window in thousands of tokens, when known (the sponsor's list carries it). */
  contextK?: number;
};
export const MODEL_PROVIDER_SETTING = "model.provider";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
export const isLocalProvider = (baseUrl: string) => { try { return LOOPBACK.has(new URL(baseUrl).hostname); } catch { return false; } };

/**
 * The base URL as stored: spaces and trailing slashes gone, and an endpoint pasted whole (`…/v1/chat/completions`, a relay's dashboard
 * often shows that) cut back to its base, since the gateway adds the endpoint itself.
 */
export function normalizeProviderBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "").replace(/\/(chat\/completions|responses|completions|models)$/i, "").replace(/\/+$/, "");
}

/** A host that is a name on the public internet: not an IP literal, not a single label, not a name kept for local networks. */
const LOCAL_SUFFIX = /\.(local|localhost|internal|intranet|lan|home|corp|localdomain|home\.arpa)$/i;
const publicDomainName = (host: string) => !host.startsWith("[") && !/^[\d.]+$/.test(host) && !/^0x/i.test(host) && host.includes(".")
  && !LOCAL_SUFFIX.test(host) && /^[a-z0-9.-]+$/i.test(host);

/**
 * Why a provider configuration cannot be saved, in words the person reads; undefined when it can. The address must be https on a
 * public domain name; a model on this computer (loopback, plain http allowed) only where Crossline itself runs on the person's computer
 * (`allowLoopback`, off on the hosted server, where loopback is the server's own services). Whether the name resolves to a public address
 * is the worker's check (`resolvesPublicly`), on saving and on every request.
 */
export function providerConfigProblem(config: Pick<ProviderConfig, "id" | "kind" | "baseUrl" | "model" | "label">, locale?: Locale,
  options: { allowLoopback?: boolean } = {}): string | undefined {
  const t = tFor(locale);
  if (!/^[a-z0-9-]{1,32}$/.test(config.id)) return t("名称只能用小写字母、数字和连字符。");
  if (!["chat", "responses", "siwc-plan"].includes(config.kind)) return t("接口类型不认识。");
  if (!config.label.trim() || config.label.length > 40) return t("请填一个 40 字以内的显示名称。");
  if (!config.baseUrl.trim()) return t("请填写接口地址（base URL）。");
  let url: URL;
  try { url = new URL(config.baseUrl); } catch { return t("接口地址不是一个网址。"); }
  if (url.username || url.password || url.search || url.hash) return t("接口地址里不能带账号、参数或 #。");
  const loopback = LOOPBACK.has(url.hostname);
  if (loopback) {
    if (options.allowLoopback === false) return t("网页版连接不到本机地址；请填写模型服务的公网 https 地址。");
    if (url.protocol !== "https:" && url.protocol !== "http:") return t("接口地址必须是 https；只有本机模型（127.0.0.1）可以用 http。");
  } else {
    if (url.protocol !== "https:") return t("接口地址必须是 https；只有本机模型（127.0.0.1）可以用 http。");
    if (!publicDomainName(url.hostname)) return t("接口地址要用公网域名，不能是 IP 地址或内网地址。");
  }
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
  /**
   * Whether the provider's conformance record shows it calling a function when asked (`callsFunctions`): a run whose lookups are
   * optional (`SkillRunOptions.optionalTools`) gets them only then. Unset counts as no.
   */
  functionCalls?: boolean;
  /**
   * Why this provider serves nothing right now, in the person's words (the developer's model for invited accounts: still being tested,
   * or this month's cap reached). The workspace's own Codex sign-in still serves; without one the run stops with this.
   */
  blocked?: { code: "MODEL_SPONSOR_PENDING" | "MODEL_SPONSOR_BUDGET"; message: string };
  /** A model of the same provider for one Skill (the developer's cheaper model for simple background work); otherwise the provider's. */
  modelFor?: (skillKey: string) => string | undefined;
  /**
   * Set while the account's own ChatGPT quota is spent and the developer's model stands in (`CHATGPT_EXHAUSTED_SETTING`): what the
   * developer's model cannot serve is refused with that said, rather than sent to a ChatGPT login that would refuse it again.
   */
  chatgptExhausted?: { until?: string };
};

let resolver: ((workspaceId: string | undefined) => ProviderRouting | undefined) | undefined;
let usageLimitHandler: ((workspaceId: string) => void) | undefined;
/** Installed once by the worker: a run on the account's own ChatGPT came back `SKILL_USAGE_LIMIT` (the quota is spent). */
export function setUsageLimitHandler(next: ((workspaceId: string) => void) | undefined): void { usageLimitHandler = next; }
/** Tells the worker the current workspace's ChatGPT quota refused a run, so the routing that follows can move to the developer's model. */
export function noteChatgptUsageLimit(): void {
  const workspaceId = currentUsageWorkspace();
  if (!workspaceId) return;
  try { usageLimitHandler?.(workspaceId); } catch { /* the next quota reading says the same */ }
}
/** Installed once by the worker; with none installed every run keeps the Codex sign-in it always had. */
export function setProviderResolver(next: ((workspaceId: string | undefined) => ProviderRouting | undefined) | undefined): void { resolver = next; }
export function currentProviderRouting(): ProviderRouting | undefined {
  try { return resolver?.(currentUsageWorkspace()); } catch { return undefined; }
}
/** Where a run of this Skill would go for the current workspace, for callers that act outside a model turn (the portrait figure). */
export const currentRoute = (skillName: string): RouteDecision => decideRoute(skillName, currentProviderRouting());

/** What Codex is given for one thread: the provider's id and its definition (no key — the gateway adds it). */
/** `contextWindow`: the model's context in tokens when known (the sponsor's list says it), for compaction before it overflows. */
export type ThreadProvider = { id: string; model: string; definition: Record<string, unknown>; contextWindow?: number };
export type RouteDecision = { via: "codex" } | { via: "provider"; provider: ThreadProvider }
  | { via: "blocked"; code: "MODEL_CAPABILITY_MISSING" | "MODEL_NOT_ADMITTED" | "MODEL_SPONSOR_PENDING" | "MODEL_SPONSOR_BUDGET"; message: string };

export function threadProvider(routing: Pick<ProviderRouting, "provider" | "gatewayUrl">, model: string, skill?: string): ThreadProvider {
  return { id: `crossline-${routing.provider.id}`, model, ...(routing.provider.contextK ? { contextWindow: routing.provider.contextK * 1000 } : {}), definition: {
    name: routing.provider.label, base_url: routing.gatewayUrl, wire_api: "responses", requires_openai_auth: false, supports_websockets: false,
    // A local model can think for minutes before its first word; the gateway streams its reasoning, but leave room.
    stream_idle_timeout_ms: 600_000, request_max_retries: 2, stream_max_retries: 2,
    // Which Skill the thread runs, for the gateway: a person's turn refused for load goes to another model, background work waits.
    ...(skill ? { http_headers: { "x-crossline-skill": skill } } : {}) } };
}

/**
 * Where one run of a Skill goes, in the order the review set (§7.2): the workspace's provider when it can do what the Skill needs and
 * its conformance admits the Skill; else the workspace's own Codex sign-in; else a blocker that says why, which the caller turns into
 * an ask. There is never a third option — a workspace that has neither does not borrow the machine owner's runtime.
 */
export function decideRoute(skillName: string, routing: ProviderRouting | undefined,
  options: { mainModel?: boolean; locale?: Locale } = {}): RouteDecision {
  if (!routing) return { via: "codex" };
  if (routing.blocked) return routing.codexSignedIn ? { via: "codex" } : { via: "blocked", ...routing.blocked };
  // The blocker is shown to the person: in the run's language (the workspace's, unless the caller names one).
  const language = options.locale ?? runLocale(undefined, currentUsageWorkspace());
  const t = tFor(language);
  const key = skillKey(skillName);
  const gap = capabilityGap(key, { ...THIRD_PARTY_CAPABILITIES, ...routing.capabilities }, language);
  // `mainModel`: the provider's own model even where this Skill has one of its own (a planning run redone after a repair).
  const model = (options.mainModel ? undefined : routing.modelFor?.(key)) ?? routing.provider.model;
  if (!gap && routing.admitted.has(key)) return { via: "provider", provider: threadProvider(routing, model, key) };
  if (routing.codexSignedIn) return { via: "codex" };
  const label = t(SKILL_NEEDS[key]?.label ?? "这项功能");
  if (routing.chatgptExhausted) {
    const time = routing.chatgptExhausted.until?.slice(0, 16).replace("T", " ");
    const values = { feature: label, gap: gap ?? "", time: time ?? "" };
    const message = time
      ? gap ? t("ChatGPT 额度已用尽，{{time}}（UTC）恢复；{{feature}}开发者提供的模型做不了（{{gap}}），等 ChatGPT 额度恢复后继续。", values)
        : t("ChatGPT 额度已用尽，{{time}}（UTC）恢复；{{feature}}开发者提供的模型做不了，等 ChatGPT 额度恢复后继续。", values)
      : gap ? t("ChatGPT 额度已用尽；{{feature}}开发者提供的模型做不了（{{gap}}），等 ChatGPT 额度恢复后继续。", values)
        : t("ChatGPT 额度已用尽；{{feature}}开发者提供的模型做不了，等 ChatGPT 额度恢复后继续。", values);
    return { via: "blocked", code: gap ? "MODEL_CAPABILITY_MISSING" : "MODEL_NOT_ADMITTED", message };
  }
  return gap ? { via: "blocked", code: "MODEL_CAPABILITY_MISSING", message: gap }
    : { via: "blocked", code: "MODEL_NOT_ADMITTED", message: t("{{feature}}还没有交给「{{provider}}」：它还没通过这项功能的检验。到 设置 → 模型连接 运行检验，或登录 ChatGPT。", { feature: label, provider: t(routing.provider.label) }) };
}
