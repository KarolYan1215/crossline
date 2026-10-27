// i18n-exempt: the compute node's own words, shown by the standalone node program (bundled alone, without the catalogues; Chinese only)
import type { AppServerLines } from "./agent";

/**
 * A short-lived Codex runtime for a node's own account (docs/compute-node.md): reading who is signed in, signing in with ChatGPT or an
 * OpenAI API key, signing out. Not the relay's runtime: that one starts per connection and carries only the site's requests.
 */
export type ControlRequest = (method: string, params: unknown) => Promise<Record<string, unknown>>;
export async function withControl<T>(spawn: () => AppServerLines,
  work: (request: ControlRequest, notified: (method: string) => Promise<Record<string, unknown>>) => Promise<T>): Promise<T> {
  const runtime = spawn();
  let next = 0;
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  const waiting = new Map<string, (params: Record<string, unknown>) => void>();
  runtime.onLine((line) => {
    let message: Record<string, unknown>;
    try { message = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    if (typeof message.id === "number" && !message.method) { pending.get(message.id)?.(message); pending.delete(message.id); return; }
    if (typeof message.method === "string" && message.id === undefined) waiting.get(message.method)?.((message.params ?? {}) as Record<string, unknown>);
  });
  const request: ControlRequest = (method, params) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, (message) => message.error ? reject(new Error(JSON.stringify(message.error))) : resolve((message.result ?? {}) as Record<string, unknown>));
    runtime.write(JSON.stringify({ id, method, params }));
  });
  const notified = (method: string) => new Promise<Record<string, unknown>>((resolve) => waiting.set(method, resolve));
  try {
    await request("initialize", { clientInfo: { name: "crossline", title: "Crossline", version: "0.1.0" }, capabilities: { experimentalApi: true, requestAttestation: false } });
    runtime.write(JSON.stringify({ method: "initialized" }));
    return await work(request, notified);
  } finally { runtime.stop(); }
}

export type NodeAccount = { type?: string; email?: string } | null;
/** Who the node's Codex is signed in as; null when nobody. */
export const readNodeAccount = (spawn: () => AppServerLines): Promise<NodeAccount> =>
  withControl(spawn, async (request) => ((await request("account/read", { refreshToken: false })).account as NodeAccount) ?? null);

/** OpenAI API keys look like this; anything else is refused before Codex sees it. */
export const API_KEY_SHAPE = /^sk-[A-Za-z0-9_-]{20,200}$/;
/**
 * Signs the node's Codex in with an OpenAI API key: Codex keeps it in its own home; nothing here stores, logs or returns it. Codex does
 * not check a key until a run uses it, so a mistyped one shows up as that run failing, not here.
 */
export async function loginNodeWithApiKey(spawn: () => AppServerLines, apiKey: string): Promise<{ ok: true; account: NodeAccount } | { ok: false; message: string }> {
  if (!API_KEY_SHAPE.test(apiKey)) return { ok: false, message: "这不像 OpenAI 的 API key（以 sk- 开头）" };
  try {
    const account = await withControl(spawn, async (request) => {
      await request("account/login/start", { type: "apiKey", apiKey });
      return ((await request("account/read", { refreshToken: false })).account as NodeAccount) ?? null;
    });
    return account ? { ok: true, account } : { ok: false, message: "Codex 没有接受这个 key" };
  } catch { return { ok: false, message: "Codex 没有接受这个 key：检查是否完整、是否还有效" }; }
}
