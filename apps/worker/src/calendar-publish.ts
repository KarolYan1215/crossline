import { CrosslineCalendarWriter, PublishInterruptedError, type PublishBlock, type PublishLedger, type PublishResult } from "@crossline/connectors";
import { FROZEN_SETTING, parseFrozen, withFrozen } from "@crossline/core";
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

/**
 * One publish per workspace at a time. Each publish reads the record of what was written, changes the calendar and writes the record
 * back; two at once (the ten-minute pass, the optimal plan landing, the fixed events, the 发布 button) each read the other's fresh writes
 * as the person's doing. On the real account (2026-10-15) that had locked 56 blocks no one had touched (read back at the other run's
 * new time = 「dragged」), marked 10 as deleted by the person and left 19 events in the Crossline calendar with no record at all.
 */
const queues = new Map<string, Promise<unknown>>();
function serialized<T>(workspaceId: string, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(workspaceId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(run);
  const tail = current.catch(() => undefined);
  queues.set(workspaceId, tail);
  void tail.then(() => { if (queues.get(workspaceId) === tail) queues.delete(workspaceId); });
  return current;
}

export function createCalendarPublisher(store: CrosslineStore, workspaceId: string, deps: {
  /** A credential for one account, asked for the calendar-write scopes. */
  credentialFor: (accountId: string) => { getAccessToken(): Promise<string | undefined> };
  fetchImpl?: typeof fetch; now?: () => Date;
}) {
  /** `fixed`: the person's fixed events (ids `fixed:`); `work`: everything else this writer made. Each call manages only its own. */
  return (blocks: PublishBlock[], scope: "work" | "fixed" = "work"): Promise<PublishOutcome> => serialized(workspaceId, () => publishOnce(blocks, scope));
  async function publishOnce(blocks: PublishBlock[], scope: "work" | "fixed"): Promise<PublishOutcome> {
    const accountId = store.getSetting(workspaceId, ACCOUNT);
    if (!accountId) return NOT_AUTHORIZED;
    const writer = new CrosslineCalendarWriter({
      credential: deps.credentialFor(accountId),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), ...(deps.now ? { now: deps.now } : {})
    });
    try {
      const fixed = (id: string) => id.startsWith("fixed:");
      // A finished task's leftover events are clutter even if the person renamed or moved them.
      const finished = new Set(store.listWorkOrders(workspaceId).filter((order) => ["accepted", "evidence_review", "archived"].includes(order.state)).map((order) => order.id));
      const { result, ledger, edits } = await writer.publish(blocks, readPublishLedger(store, workspaceId), {
        manages: (id) => scope === "fixed" ? fixed(id) : !fixed(id),
        forceRemove: (id) => id.startsWith("scheduled:") && finished.has(id.split(":")[1] ?? "") });
      store.setSetting(workspaceId, LEDGER, JSON.stringify(ledger));
      // A work block the person dragged to another time on their calendar is locked there (docs/loop-and-scout.md §1).
      const dragged = edits.moved.filter((item) => item.blockId.startsWith("scheduled:"));
      if (dragged.length) {
        const now = deps.now?.() ?? new Date();
        let frozen = parseFrozen(store.getSetting(workspaceId, FROZEN_SETTING), now);
        for (const item of dragged) frozen = withFrozen(frozen, { blockId: item.blockId, start: item.start, end: item.end, reason: "locked", via: "calendar" });
        store.setSetting(workspaceId, FROZEN_SETTING, JSON.stringify(frozen));
      }
      const ownerId = store.getWorkspaceOwnerId(workspaceId);
      if (ownerId) {
        // Provenance, not content: how many events were made, moved or removed, and which the person had taken over.
        store.appendEvent({ ownerId, workspaceId, idempotencyKey: `calendar:published:${Date.now()}`, type: "calendar.published", entityId: result.calendarId,
          payload: { created: result.created, updated: result.updated, deleted: result.deleted, unchanged: result.unchanged, keptAsEdited: result.keptAsEdited.length } });
      }
      return { state: "published", account: accountId, result };
    } catch (error) {
      // What was written before it stopped stays on record, so the next run does not take this run's own writes for the person's.
      if (error instanceof PublishInterruptedError) store.setSetting(workspaceId, LEDGER, JSON.stringify(error.ledger));
      const code = error instanceof Error ? error.message.split(":")[0]! : "CALENDAR_PUBLISH_FAILED";
      if (code === "CALENDAR_WRITE_NOT_AUTHORIZED") return NOT_AUTHORIZED;
      return { state: "blocked", code, message: `Crossline 日历写入未完成；其他日历未受影响。` };
    }
  }
}

export { ACCOUNT as WRITE_ACCOUNT_SETTING };
