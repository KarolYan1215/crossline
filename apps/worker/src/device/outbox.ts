import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The device's outbox (docs/device-mode.md 「发送：本地发件箱」): everything a linked computer sends to the hosted site is first written
 * here as one file, then sent, and deleted only once the site has taken it — so a lost connection, a restart of either side or a sleep of
 * the laptop loses nothing. Each item carries an idempotency key the site remembers, so sending it twice applies it once.
 *
 * Items are sent oldest first. A failed send waits 30 s, 1 min, 2 min … up to an hour before its next try. 401/403 (the token was revoked
 * or replaced) stops sending until the link is made again; a permanent refusal (400, 413, 415, 422) moves the item to `dead/`, where it
 * stays for the person to see and is never retried.
 */
export type OutboxItem = {
  /** The idempotency key, also the item's identity: a second item with the same id is not added. */
  id: string;
  /** Items of the same `supersedes` replace one another while unsent: only the newest activity snapshot is worth sending. */
  supersedes?: string;
  /** The hosted route, e.g. `/api/device/activity`. */
  route: string;
  body: unknown;
  createdAt: string;
  attempts: number;
  nextAt: string;
  lastError?: string;
};
export type SendResult = { status: number; body?: unknown };
export type OutboxStats = { pending: number; dead: number; blocked?: { code: string; at: string }; lastSentAt?: string; lastError?: string; nextAt?: string };

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 60 * 60_000;
const DEAD_KEEP = 200;
const PERMANENT = new Set([400, 404, 405, 413, 415, 422]);
const safe = (id: string) => id.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);

/** How long after its `attempts`-th failure an item waits. */
export const backoffMs = (attempts: number) => Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));

export function createOutbox(dir: string, deps: { send: (item: OutboxItem) => Promise<SendResult>; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());
  const deadDir = path.join(dir, "dead");
  const statusFile = path.join(dir, "status.json");
  mkdirSync(deadDir, { recursive: true });
  let flushing: Promise<OutboxStats> | undefined;
  let sequence = 0;

  type Status = { blocked?: { code: string; at: string }; lastSentAt?: string; lastError?: string };
  const readStatus = (): Status => { try { return JSON.parse(readFileSync(statusFile, "utf8")) as Status; } catch { return {}; } };
  const writeStatus = (status: Status) => writeFileSync(statusFile, JSON.stringify(status));
  const files = () => readdirSync(dir).filter((name) => name.endsWith(".json") && name !== "status.json").sort();
  const load = (name: string): OutboxItem | undefined => { try { return JSON.parse(readFileSync(path.join(dir, name), "utf8")) as OutboxItem; } catch { return undefined; } };
  const save = (name: string, item: OutboxItem) => {
    const part = path.join(dir, `${name}.part`);
    writeFileSync(part, JSON.stringify(item));
    renameSync(part, path.join(dir, name));
  };
  const stats = (): OutboxStats => {
    const status = readStatus();
    const pending = files().map(load).filter((item): item is OutboxItem => Boolean(item));
    const nextAt = pending.map((item) => item.nextAt).sort()[0];
    return { pending: pending.length, dead: readdirSync(deadDir).filter((name) => name.endsWith(".json")).length,
      ...(status.blocked ? { blocked: status.blocked } : {}), ...(status.lastSentAt ? { lastSentAt: status.lastSentAt } : {}),
      ...(status.lastError ? { lastError: status.lastError } : {}), ...(nextAt ? { nextAt } : {}) };
  };

  return {
    /** Adds an item unless one with its id waits already; an unsent item it supersedes is dropped. Returns whether it was added. */
    enqueue(input: { id: string; route: string; body: unknown; supersedes?: string }): boolean {
      const existing = files().map((name) => ({ name, item: load(name) }));
      if (existing.some(({ item }) => item?.id === input.id)) return false;
      for (const { name, item } of existing) if (input.supersedes && item?.supersedes === input.supersedes) rmSync(path.join(dir, name), { force: true });
      const at = now().toISOString();
      sequence += 1;
      const name = `${now().getTime().toString().padStart(14, "0")}-${String(sequence).padStart(6, "0")}-${safe(input.id)}.json`;
      save(name, { id: input.id, route: input.route, body: input.body, createdAt: at, attempts: 0, nextAt: at, ...(input.supersedes ? { supersedes: input.supersedes } : {}) });
      return true;
    },

    /** Sends what is due, oldest first; one flush at a time (a second call joins the running one). */
    flush(): Promise<OutboxStats> {
      if (flushing) return flushing;
      const run = (async () => {
        {
          const status = readStatus();
          for (const name of files()) {
            const item = load(name);
            if (!item) { rmSync(path.join(dir, name), { force: true }); continue; }
            if (Date.parse(item.nextAt) > now().getTime()) continue;
            let result: SendResult | undefined;
            let error: string | undefined;
            try { result = await deps.send(item); } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
            if (result && result.status >= 200 && result.status < 300 || result?.status === 409) {
              rmSync(path.join(dir, name), { force: true });
              status.lastSentAt = now().toISOString();
              delete status.blocked; delete status.lastError;
              continue;
            }
            if (result && (result.status === 401 || result.status === 403)) {
              const code = typeof (result.body as { code?: unknown } | undefined)?.code === "string" ? (result.body as { code: string }).code : `HTTP_${result.status}`;
              status.blocked = { code, at: now().toISOString() };
              break;
            }
            if (result && PERMANENT.has(result.status)) {
              renameSync(path.join(dir, name), path.join(deadDir, name));
              status.lastError = `HTTP_${result.status}`;
              const dead = readdirSync(deadDir).sort();
              for (const old of dead.slice(0, Math.max(0, dead.length - DEAD_KEEP))) rmSync(path.join(deadDir, old), { force: true });
              continue;
            }
            const attempts = item.attempts + 1;
            const waited = result?.status === 429 ? Math.max(backoffMs(attempts), 5 * 60_000) : backoffMs(attempts);
            status.lastError = error ?? `HTTP_${result?.status ?? 0}`;
            save(name, { ...item, attempts, nextAt: new Date(now().getTime() + waited).toISOString(), lastError: status.lastError });
            // The site is unreachable or busy: the rest would fail the same way; they wait for the next flush.
            break;
          }
          writeStatus(status);
          return stats();
        }
      })();
      // Cleared once this run settles (not inside it: a run with nothing to await settles before it could be assigned).
      const guarded: Promise<OutboxStats> = run.finally(() => { if (flushing === guarded) flushing = undefined; });
      flushing = guarded;
      return guarded;
    },

    stats,

    /** A new link: the stop for a revoked token is lifted and everything waiting is tried at once. */
    unblock(): void {
      const status = readStatus();
      delete status.blocked;
      writeStatus(status);
      for (const name of files()) { const item = load(name); if (item) save(name, { ...item, nextAt: now().toISOString() }); }
    }
  };
}
export type Outbox = ReturnType<typeof createOutbox>;
