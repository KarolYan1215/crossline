import "server-only";
import { ASSESS_DECLINED_SETTING, ASSESS_LINK_PATH, ASSESS_RESULT_SETTING, TYPE_TABLE, parseAssessLinkResponse, type AssessLinkResponse } from "@crossline/core";

/**
 * The public quick test's result, carried into the app (contract: `packages/core/src/assess-link.ts`; decided by the owner 2026-10-15).
 * Before the interview starts the app asks the test's server, server to server, for the latest result held under the person's verified
 * address, and shows it; nothing is written until the person presses 「使用该结果」. 「不是我的结果」 (or removing it later) deletes it and
 * stops the asking for good. Off entirely unless both `ASSESS_BASE_URL` and `ASSESS_LINK_SECRET` are set; an unreachable or malformed
 * answer is skipped silently and asked again next time, so the interview never waits on it.
 */
export type AssessFound = Extract<AssessLinkResponse, { found: true }>;
export type AssessStored = AssessFound & { source: "public-assess"; acceptedAt: string };
export type AssessOffer =
  | { state: "off" } | { state: "none" } | { state: "declined" }
  | { state: "offered"; result: AssessFound } | { state: "used"; result: AssessStored };

type Settings = { getSetting(workspaceId: string, key: string): string | undefined; setSetting(workspaceId: string, key: string, value: string): void;
  deleteSetting(workspaceId: string, key: string): void };
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export function assessLinkConfig(env: NodeJS.ProcessEnv = process.env): { base: string; secret: string } | undefined {
  const base = env.ASSESS_BASE_URL?.trim().replace(/\/+$/, ""), secret = env.ASSESS_LINK_SECRET?.trim();
  return base && secret && /^https?:\/\//.test(base) ? { base, secret } : undefined;
}

/** One ask; undefined for not found, unreachable, a refusal or an answer that does not parse — all of which are simply skipped. */
export async function lookupAssess(email: string, fetcher: Fetcher = fetch, env: NodeJS.ProcessEnv = process.env): Promise<AssessFound | undefined> {
  const config = assessLinkConfig(env);
  if (!config) return undefined;
  try {
    const response = await fetcher(`${config.base}${ASSESS_LINK_PATH}`, { method: "POST", signal: AbortSignal.timeout(5_000),
      headers: { "content-type": "application/json", authorization: `Bearer ${config.secret}` }, body: JSON.stringify({ email }) });
    if (!response.ok) return undefined;
    const parsed = parseAssessLinkResponse(await response.json());
    return parsed?.found ? parsed : undefined;
  } catch { return undefined; }
}

export function storedAssess(store: Settings, workspaceId: string): AssessStored | undefined {
  try {
    const value = JSON.parse(store.getSetting(workspaceId, ASSESS_RESULT_SETTING) ?? "null") as AssessStored | null;
    // A result kept under the first version's codes (before 2026-10-17) is not this test's any more: offered again once retaken.
    return value?.source === "public-assess" && value.found && TYPE_TABLE[value.code] ? value : undefined;
  } catch { return undefined; }
}

/** What the interview screen shows. `email` is the session's address only when it is verified; otherwise nothing is asked. */
export async function assessOffer(store: Settings, workspaceId: string, email: string | undefined, fetcher: Fetcher = fetch,
  env: NodeJS.ProcessEnv = process.env): Promise<AssessOffer> {
  const used = storedAssess(store, workspaceId);
  if (used) return { state: "used", result: used };
  if (!assessLinkConfig(env)) return { state: "off" };
  if (store.getSetting(workspaceId, ASSESS_DECLINED_SETTING)) return { state: "declined" };
  if (!email) return { state: "none" };
  const found = await lookupAssess(email, fetcher, env);
  return found ? { state: "offered", result: found } : { state: "none" };
}

/** 「使用该结果」 asks again (the screen's copy is not trusted) and keeps the contract's fields; 「不是我的结果」/「移除」 forgets it for good. */
export async function decideAssess(store: Settings, workspaceId: string, email: string | undefined, decision: "use" | "reject",
  fetcher: Fetcher = fetch, env: NodeJS.ProcessEnv = process.env, now = new Date()): Promise<AssessOffer> {
  if (decision === "reject") {
    store.deleteSetting(workspaceId, ASSESS_RESULT_SETTING);
    store.setSetting(workspaceId, ASSESS_DECLINED_SETTING, now.toISOString());
    return { state: "declined" };
  }
  if (!email || store.getSetting(workspaceId, ASSESS_DECLINED_SETTING)) return { state: "none" };
  const found = await lookupAssess(email, fetcher, env);
  if (!found) return { state: "none" };
  const result: AssessStored = { ...found, source: "public-assess", acceptedAt: now.toISOString() };
  store.setSetting(workspaceId, ASSESS_RESULT_SETTING, JSON.stringify(result));
  return { state: "used", result };
}

/**
 * The figure's thumbnail, fetched here and served from the app's own origin: in `private` mode the page may load images only from itself.
 * Only an image on the test server's own origin is fetched (never an address the answer merely names elsewhere), at most 2 MB.
 */
export async function assessFigure(result: AssessFound | AssessStored | undefined, fetcher: Fetcher = fetch, env: NodeJS.ProcessEnv = process.env):
  Promise<{ bytes: ArrayBuffer; type: string } | undefined> {
  const config = assessLinkConfig(env);
  const url = (result as { figureUrl?: unknown } | undefined)?.figureUrl;
  if (!config || typeof url !== "string") return undefined;
  try {
    if (new URL(url).origin !== new URL(config.base).origin) return undefined;
    const response = await fetcher(url, { method: "GET", signal: AbortSignal.timeout(5_000) });
    const type = response.headers.get("content-type") ?? "";
    if (!response.ok || !/^image\/(png|jpeg|webp)$/.test(type.split(";")[0]!.trim())) return undefined;
    const bytes = await response.arrayBuffer();
    return bytes.byteLength <= 2 * 1024 * 1024 ? { bytes, type } : undefined;
  } catch { return undefined; }
}
