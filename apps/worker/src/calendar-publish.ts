import { CrosslineCalendarWriter, type PublishBlock, type PublishLedger, type PublishResult } from "@crossline/connectors";
import type { CrosslineStore } from "@crossline/db";

/**
 * The plan's work blocks, written to the Crossline calendar in the person's Microsoft account.
 *
 * Which account is the person's choice, made once when they sign in for it (`scripts/graph-write-login.ts`) and stored as
 * `calendar.write.account`. Nothing here picks an account for them: with none chosen, nothing is written. What was last written for each
 * block is kept (`calendar.published`) so a later run can tell its own events from ones the person has since changed.
 */
export type PublishOutcome =
  | { state: "published"; account: string; result: PublishResult }
  | { state: "blocked"; code: string; message: string };

const ACCOUNT = "calendar.write.account";
const LEDGER = "calendar.published";
const NOT_AUTHORIZED = { state: "blocked" as const, code: "CALENDAR_WRITE_NOT_AUTHORIZED",
  message: "尚未授权写入 Crossline 日历；登录用于存放 Crossline 日历的账号后重试。" };

export function readPublishLedger(store: CrosslineStore, workspaceId: string): PublishLedger {
  try { return JSON.parse(store.getSetting(workspaceId, LEDGER) ?? "{}") as PublishLedger; } catch { return {}; }
}

export function createCalendarPublisher(store: CrosslineStore, workspaceId: string, deps: {
  /** A credential for one account, asked for the calendar-write scopes. */
  credentialFor: (accountId: string) => { getAccessToken(): Promise<string | undefined> };
  fetchImpl?: typeof fetch; now?: () => Date;
}) {
  return async function publish(blocks: PublishBlock[]): Promise<PublishOutcome> {
    const accountId = store.getSetting(workspaceId, ACCOUNT);
    if (!accountId) return NOT_AUTHORIZED;
    const writer = new CrosslineCalendarWriter({
      credential: deps.credentialFor(accountId),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), ...(deps.now ? { now: deps.now } : {})
    });
    try {
      const { result, ledger } = await writer.publish(blocks, readPublishLedger(store, workspaceId));
      store.setSetting(workspaceId, LEDGER, JSON.stringify(ledger));
      const ownerId = store.getWorkspaceOwnerId(workspaceId);
      if (ownerId) {
        // Provenance, not content: how many events were made, moved or removed, and which the person had taken over.
        store.appendEvent({ ownerId, workspaceId, idempotencyKey: `calendar:published:${Date.now()}`, type: "calendar.published", entityId: result.calendarId,
          payload: { created: result.created, updated: result.updated, deleted: result.deleted, unchanged: result.unchanged, keptAsEdited: result.keptAsEdited.length } });
      }
      return { state: "published", account: accountId, result };
    } catch (error) {
      const code = error instanceof Error ? error.message.split(":")[0]! : "CALENDAR_PUBLISH_FAILED";
      if (code === "CALENDAR_WRITE_NOT_AUTHORIZED") return NOT_AUTHORIZED;
      return { state: "blocked", code, message: `Crossline 日历写入未完成；其他日历未受影响。` };
    }
  };
}

export { ACCOUNT as WRITE_ACCOUNT_SETTING };
