/**
 * Near-duplicate candidates among the person's files (docs/plans/2026-11-22-interview-and-import-redesign.md §四.3.4): code only circles
 * pairs whose text is close, by a 64-bit SimHash over character 4-grams (works the same for Chinese and English); whether two files are
 * versions of one document, and which is the latest, is the model's call (Skill `crossline-source-digest`). Exact copies are already one
 * row (`UNIQUE(workspace_id, sha256)`).
 */

/** Characters of a text the fingerprint reads: enough for a document's identity, cheap for a long one. */
const SIMHASH_TEXT = 60_000;
/** Texts shorter than this are not fingerprinted: a few lines of anything look alike. */
export const NEAR_DUPLICATE_MIN_CHARS = 300;
/** Bits two fingerprints may differ in and still be a candidate pair; loose on purpose, since the model confirms every pair. */
export const NEAR_DUPLICATE_BITS = 12;

/** FNV-1a, 32-bit, with a seed so two independent halves make a 64-bit hash. */
function fnv(text: string, seed: number): number {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The 64-bit SimHash of `text` as 16 hex characters, or undefined when the text is too short to say anything. */
export function simhash(text: string): string | undefined {
  const clean = text.slice(0, SIMHASH_TEXT).toLowerCase().replace(/\s+/g, " ").trim();
  if (clean.length < NEAR_DUPLICATE_MIN_CHARS) return undefined;
  const counts = new Map<string, number>();
  for (let index = 0; index + 4 <= clean.length; index += 1) { const gram = clean.slice(index, index + 4); counts.set(gram, (counts.get(gram) ?? 0) + 1); }
  const weights = new Array<number>(64).fill(0);
  for (const [gram, count] of counts) {
    const halves = [fnv(gram, 0), fnv(gram, 0x9e3779b9)];
    for (let bit = 0; bit < 64; bit += 1) weights[bit]! += ((halves[bit >> 5]! >>> (bit & 31)) & 1) ? count : -count;
  }
  const word = (from: number) => { let value = 0; for (let bit = 31; bit >= 0; bit -= 1) value = (value << 1) | (weights[from + bit]! > 0 ? 1 : 0); return value >>> 0; };
  return [word(0), word(32)].map((value) => value.toString(16).padStart(8, "0")).join("");
}

/** Bits in which two fingerprints differ. */
export function simhashDistance(a: string, b: string): number {
  let bits = 0;
  for (let index = 0; index < 16; index += 8) {
    let diff = (parseInt(a.slice(index, index + 8), 16) ^ parseInt(b.slice(index, index + 8), 16)) >>> 0;
    while (diff) { diff &= diff - 1; bits += 1; }
  }
  return bits;
}

/** Pairs of ids whose fingerprints are within `NEAR_DUPLICATE_BITS`, closest first; each pair once, the earlier id first. */
export function nearDuplicatePairs(items: Array<{ id: string; hash: string }>, maxBits = NEAR_DUPLICATE_BITS): Array<{ a: string; b: string; bits: number }> {
  const pairs: Array<{ a: string; b: string; bits: number }> = [];
  for (let i = 0; i < items.length; i += 1) for (let j = i + 1; j < items.length; j += 1) {
    const bits = simhashDistance(items[i]!.hash, items[j]!.hash);
    if (bits <= maxBits) pairs.push({ a: items[i]!.id, b: items[j]!.id, bits });
  }
  return pairs.sort((x, y) => x.bits - y.bits);
}
