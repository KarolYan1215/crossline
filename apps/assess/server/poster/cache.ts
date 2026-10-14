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
export const LAYOUT_VERSION = 1;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

const postersDir = () => path.join(dataDir(), "posters");
const inFlight = new Map<string, Promise<Buffer>>();
let lastPrune = 0;

/** The bytes of a file, or "" when it cannot be read: the hash then changes the moment the figure appears. */
export function fileDigest(file: string): string {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return "";
  }
}

export function posterKey(kind: string, parts: unknown): string {
  return `${kind}-${createHash("sha256").update(JSON.stringify({ v: LAYOUT_VERSION, kind, parts })).digest("hex").slice(0, 40)}`;
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
    const png = await render();
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
