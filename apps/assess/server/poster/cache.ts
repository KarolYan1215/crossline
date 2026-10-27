import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../config";

/**
 * Rendered posters kept on disk under `dataDir()/posters`, named by a hash of everything that went into them (the layout version, the
 * view, the nickname, the invitation link and the figure file's bytes), so a changed figure or a re-laid-out poster is a new file and a
 * repeat request is a read. A poster carries a nickname, so files are pruned a week after they were written; a request after that
 * simply draws it again. Two requests for the same poster at once share one render.
 */

/** Bump when the layout changes, so posters drawn by the old layout are not served. */
export const LAYOUT_VERSION = 9;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

const postersDir = () => path.join(dataDir(), "posters");
const inFlight = new Map<string, Promise<Buffer>>();
let lastPrune = 0;

/**
 * Renders at once, process-wide. A render holds the laid-out SVG and a 1080-wide bitmap (about 10 MB, a quarter of a second), and a
 * burst of people reaching their results together must queue for the CPU rather than all hold one in a 250–350 MB container
 * (decided 2026-10-16, to let many people take the test at the same time). `ASSESS_RENDER_CONCURRENCY` overrides it.
 */
const RENDERS = Math.max(1, Number(process.env.ASSESS_RENDER_CONCURRENCY) || 2);
let rendering = 0;
const renderWaiters: Array<() => void> = [];
async function renderSlot<T>(work: () => Promise<T>): Promise<T> {
  if (rendering >= RENDERS) await new Promise<void>((resolve) => renderWaiters.push(resolve));
  else rendering += 1;
  try { return await work(); }
  finally {
    // Hand the slot straight to the next waiter, so the count never dips and lets a newcomer jump the line.
    const next = renderWaiters.shift();
    if (next) next(); else rendering -= 1;
  }
}

/** The bytes of a file, or "" when it cannot be read: the hash then changes the moment the figure appears. */
export function fileDigest(file: string): string {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return "";
  }
}

/**
 * The file name a poster is kept under. `owner` — the invitation token for a type poster or long image, the pair token for a pair card —
 * goes in front, so deleting a result can remove every poster drawn for it (`removeOwnedPosters`) instead of leaving a picture with the
 * person's nickname and figure on disk for up to a week. Tokens are base64url, which has no `.`, so `<owner>.` never matches another.
 */
export function posterKey(kind: string, parts: unknown, owner?: string): string {
  const key = `${kind}-${createHash("sha256").update(JSON.stringify({ v: LAYOUT_VERSION, kind, parts })).digest("hex").slice(0, 40)}`;
  return owner ? `${owner}.${key}` : key;
}

/** Removes every cached poster drawn for these owners (a deleted result's invitation token and its pairs' tokens). */
export function removeOwnedPosters(owners: string[]): void {
  const dir = postersDir();
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  const prefixes = owners.filter(Boolean).map((owner) => `${owner}.`);
  for (const name of names) {
    if (!prefixes.some((prefix) => name.startsWith(prefix))) continue;
    try { unlinkSync(path.join(dir, name)); } catch { /* already gone */ }
  }
}

function prune(dir: string, now: number): void {
  if (now - lastPrune < PRUNE_EVERY_MS) return;
  lastPrune = now;
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    try {
      if (now - statSync(file).mtimeMs > KEEP_MS) unlinkSync(file);
    } catch { /* another process got there first */ }
  }
}

export async function cachedPng(key: string, render: () => Promise<Buffer>): Promise<Buffer> {
  const dir = postersDir();
  const file = path.join(dir, `${key}.png`);
  try {
    return readFileSync(file);
  } catch { /* not drawn yet */ }
  const pending = inFlight.get(key);
  if (pending) return pending;
  const work = (async () => {
    const png = await renderSlot(render);
    mkdirSync(dir, { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, png);
    renameSync(temp, file);
    prune(dir, Date.now());
    return png;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, work);
  return work;
}
