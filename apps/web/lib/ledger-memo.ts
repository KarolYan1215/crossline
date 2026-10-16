import "server-only";
import type { CrosslineStore } from "@crossline/db";

/**
 * What pages derive from the ledger, kept until the ledger changes (2026-10-16, hosted beta). Every page rebuilt the schedule (≈270 ms)
 * and the open decisions (≈370 ms) from scratch, and the badge's poll rebuilt the decisions again a second later, so ten people opening
 * pages queued behind one Node thread doing the same work over and over. A value is reused while the ledger's change token
 * (`CrosslineStore.changeToken`: any write, by the web or the worker) is still the one taken before it was computed and it is younger
 * than `ttlMs`. The token is taken before, not after: the background solver wrote its plan while a schedule was being derived, and a
 * token read afterwards swallowed that write, so the plan from before it was served on. A derivation that writes as it goes therefore
 * computes once more on the next read, and is cheap only if it skips writes that change nothing (the schedule's own note does).
 * Callers put the minute (`appNow`) in the key of anything that depends on the time. Kept per store object, so a test that swaps the store never sees
 * another's values, and at most `MAX_ENTRIES` per store, so memory stays flat however many people use it.
 */
const MAX_ENTRIES = 64;
type Entry = { token: string; at: number; value: unknown };
const caches = new WeakMap<CrosslineStore, Map<string, Entry>>();
const inFlight = new WeakMap<CrosslineStore, Map<string, Promise<unknown>>>();

function cacheOf(store: CrosslineStore): Map<string, Entry> {
  let cache = caches.get(store);
  if (!cache) { cache = new Map(); caches.set(store, cache); }
  return cache;
}

function remember(store: CrosslineStore, key: string, token: string, value: unknown): void {
  const cache = cacheOf(store);
  cache.delete(key);
  cache.set(key, { token, at: Date.now(), value });
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
}

function fresh(store: CrosslineStore, key: string, ttlMs: number): Entry | undefined {
  const entry = cacheOf(store).get(key);
  return entry && Date.now() - entry.at < ttlMs && entry.token === store.changeToken() ? entry : undefined;
}

export function memoByLedger<T>(store: CrosslineStore, key: string, ttlMs: number, run: () => T): T {
  const hit = fresh(store, key, ttlMs);
  if (hit) return hit.value as T;
  const token = store.changeToken();
  const value = run();
  remember(store, key, token, value);
  return value;
}

/** The same for async work; requests that arrive while it runs share the one computation. */
export async function memoByLedgerAsync<T>(store: CrosslineStore, key: string, ttlMs: number, run: () => Promise<T>): Promise<T> {
  const hit = fresh(store, key, ttlMs);
  if (hit) return hit.value as T;
  let running = inFlight.get(store);
  if (!running) { running = new Map(); inFlight.set(store, running); }
  const shared = running.get(key);
  if (shared) return shared as Promise<T>;
  const token = store.changeToken();
  const work = run().then((value) => { remember(store, key, token, value); return value; }).finally(() => running!.delete(key));
  running.set(key, work);
  return work;
}

/** For reads that do not come from the ledger (another service's answer): kept `ttlMs`, whatever the ledger does. */
const timedCache = new Map<string, Entry>();
export async function memoForAsync<T>(key: string, ttlMs: number, run: () => Promise<T>): Promise<T> {
  const entry = timedCache.get(key);
  if (entry && Date.now() - entry.at < ttlMs) return entry.value as T;
  const value = await run();
  timedCache.delete(key);
  timedCache.set(key, { token: "", at: Date.now(), value });
  while (timedCache.size > MAX_ENTRIES) timedCache.delete(timedCache.keys().next().value!);
  return value;
}
