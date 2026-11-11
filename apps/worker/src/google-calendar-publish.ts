import { CALENDAR_APPS, CALENDAR_GOOGLE_LAST_SETTING, CALENDAR_GOOGLE_LEDGER_SETTING, tFor } from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";
import { GoogleInterruptedError, publishToGoogle, type GoogleBlock, type GoogleLedger } from "./google-calendar-writer";
import { localeOf } from "./locale";
import { ownerOf } from "./owner";

/** The runtime calls this path needs: what is connected, a thread to call tools on, and the tool call itself. */
export type AppsRuntime = { request(method: string, params: unknown): Promise<unknown> };
export type GoogleOutcome = { state: "published"; result: Awaited<ReturnType<typeof publishToGoogle>>["result"] } | { state: "blocked"; code: string; message: string };

const GOOGLE = CALENDAR_APPS.find((app) => app.app === "google_calendar")!;
const queues = new Map<string, Promise<unknown>>();

/**
 * Writes the person's calendar items to Google through their own runtime's connector (`google-calendar-writer.ts`). The runtime is the
 * workspace's own — its ChatGPT login is the person's — so the Google account written is the one they connected in ChatGPT, never
 * anyone else's. One publish per workspace at a time, for the same reason as the Graph writer: two at once read each other's writes as
 * the person's edits.
 */
export function publishGoogleCalendar(store: CrosslineStore, workspaceId: string, runtime: AppsRuntime, blocks: GoogleBlock[], now = () => new Date()): Promise<GoogleOutcome> {
  const previous = queues.get(workspaceId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => once(store, workspaceId, runtime, blocks, now()));
  queues.set(workspaceId, run.catch(() => undefined));
  return run;
}

async function once(store: CrosslineStore, workspaceId: string, runtime: AppsRuntime, blocks: GoogleBlock[], now: Date): Promise<GoogleOutcome> {
  const t = tFor(localeOf(store, workspaceId));
  const installed = await runtime.request("app/installed", { forceRefresh: false }).catch(() => undefined) as { apps?: Array<{ id?: string; enabled?: boolean; callable?: boolean }> } | undefined;
  const app = installed?.apps?.find((item) => item.id === GOOGLE.connectorId);
  if (!app?.enabled || app.callable === false) {
    return { state: "blocked", code: "CALENDAR_GOOGLE_NOT_CONNECTED", message: t("ChatGPT 里还没连接 Google 日历，或模型连接不是 ChatGPT 登录。") };
  }
  const thread = await runtime.request("thread/start", { sandbox: "read-only", approvalPolicy: "never", ephemeral: true }) as { thread?: { id?: string } };
  const threadId = thread.thread?.id;
  if (!threadId) return { state: "blocked", code: "CALENDAR_GOOGLE_FAILED", message: t("Google 日历写入未完成；其他日历未受影响。") };
  const call = async (tool: string, args: Record<string, unknown>) => {
    const answer = await runtime.request("mcpServer/tool/call", { threadId, server: "codex_apps", tool, arguments: args }) as { isError?: boolean; structuredContent?: unknown; content?: unknown };
    const text = Array.isArray(answer.content) ? (answer.content as Array<{ text?: unknown }>).map((part) => typeof part.text === "string" ? part.text : "").join("") : "";
    // The connector's own words go along: the writer tells Google's 409 (an event already under the id it asked for) from other failures.
    if (answer.isError) throw new Error(`GOOGLE_TOOL_FAILED:${tool}:${text.slice(0, 300)}`);
    if (answer.structuredContent !== undefined) return answer.structuredContent;
    try { return JSON.parse(text) as unknown; } catch { return { text }; }
  };
  let ledger: GoogleLedger;
  try { ledger = JSON.parse(store.getSetting(workspaceId, CALENDAR_GOOGLE_LEDGER_SETTING) ?? "null") ?? { events: {} }; } catch { ledger = { events: {} }; }
  try {
    const { result, ledger: next } = await publishToGoogle(call, blocks, ledger, now);
    store.setSetting(workspaceId, CALENDAR_GOOGLE_LEDGER_SETTING, JSON.stringify(next));
    store.setSetting(workspaceId, CALENDAR_GOOGLE_LAST_SETTING, JSON.stringify({ at: now.toISOString(), ...result }));
    store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `calendar:published:google:${now.getTime()}`, type: "calendar.published.google",
      entityId: workspaceId, payload: { ...result } });
    return { state: "published", result };
  } catch (error) {
    if (error instanceof GoogleInterruptedError) store.setSetting(workspaceId, CALENDAR_GOOGLE_LEDGER_SETTING, JSON.stringify(error.ledger));
    const code = error instanceof Error ? error.message.split(":")[0]! : "CALENDAR_GOOGLE_FAILED";
    return { state: "blocked", code: code.startsWith("GOOGLE_") ? `CALENDAR_${code}` : code, message: t("Google 日历写入未完成；其他日历未受影响。") };
  } finally {
    await runtime.request("thread/unsubscribe", { threadId }).catch(() => undefined);
  }
}
