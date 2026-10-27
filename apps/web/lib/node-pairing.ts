import "server-only";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { NODE_COMPUTE_SETTING, NODE_PAIRED_SETTING, NODE_TOKEN_SETTING, normalizePairCode, PAIR_CODE_ALPHABET, PAIR_TTL_MS, RUNTIME_OWNER_SETTING } from "@crossline/core";
import { getStore } from "./crossline";

/**
 * Pairing a standalone compute node (docs/compute-node.md, 「Crossline 节点」): the installed program asks for a code without any
 * account (`startPairing`), shows it, and keeps asking with the secret id it was given (`pollPairing`); the person types the code on the
 * 「这台电脑」 card (`approvePairing`), which makes the node its own token and switches 「作为算力节点」 on; the program fetches that token
 * once. Pending pairings live only in this process for ten minutes: a restart loses them and the program asks for a new code.
 *
 * Only the runtime owner's account may approve one (scheme A); other accounts' computers are scheme C and wait for the gateway metering
 * that design asks for.
 */
type Pairing = { id: string; code: string; host: string; expiresAt: number; workspaceId?: string; token?: string };
const pairings = ((globalThis as { crosslineNodePairings?: Map<string, Pairing> }).crosslineNodePairings ??= new Map());
const started = ((globalThis as { crosslineNodePairStarts?: Map<string, number[]> }).crosslineNodePairStarts ??= new Map());
/** At most this many codes per address an hour, and this many waiting at once: enough for a person, not for guessing at scale. */
const PER_ADDRESS_HOUR = 12;
const PENDING_MAX = 200;
const HOUR_MS = 3_600_000;

/**
 * The key an address is counted under. One IPv6 subscriber usually holds a whole /64, so counting each address apart would hand one
 * person billions of quotas: an IPv6 address counts by its first four groups. IPv4 (and IPv4 mapped into IPv6) counts as it is.
 */
export function addressKey(address: string): string {
  const raw = address.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(raw);
  if (mapped) return mapped[1]!;
  if (!raw.includes(":")) return raw;
  const [head = "", tail = ""] = raw.split("::");
  const front = head ? head.split(":") : [];
  const back = raw.includes("::") ? (tail ? tail.split(":") : []) : [];
  const groups = raw.includes("::") ? [...front, ...Array<string>(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back] : front;
  return `${groups.slice(0, 4).map((group) => (group || "0").replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** Expired pairings go, and so does every address whose last code is over an hour old: the count map no longer grows forever. */
const sweep = (now: number) => {
  for (const [id, pairing] of pairings) if (pairing.expiresAt <= now) pairings.delete(id);
  for (const [key, times] of started) {
    const recent = times.filter((at) => now - at < HOUR_MS);
    if (recent.length) started.set(key, recent); else started.delete(key);
  }
};
const newCode = () => Array.from({ length: 8 }, () => PAIR_CODE_ALPHABET[randomInt(PAIR_CODE_ALPHABET.length)]).join("");
export const showCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

export type PairStart = { ok: true; id: string; code: string; expiresAt: string } | { ok: false; code: "NODE_PAIR_BUSY" };
export function startPairing(address: string, host: string, now = Date.now()): PairStart {
  sweep(now);
  const key = addressKey(address);
  const recent = started.get(key) ?? [];
  if (recent.length >= PER_ADDRESS_HOUR || pairings.size >= PENDING_MAX) return { ok: false, code: "NODE_PAIR_BUSY" };
  started.set(key, [...recent, now]);
  let code = newCode();
  while ([...pairings.values()].some((pairing) => pairing.code === code)) code = newCode();
  const pairing: Pairing = { id: randomBytes(24).toString("base64url"), code, host: host.slice(0, 60), expiresAt: now + PAIR_TTL_MS };
  pairings.set(pairing.id, pairing);
  return { ok: true, id: pairing.id, code: showCode(code), expiresAt: new Date(pairing.expiresAt).toISOString() };
}

export type PairPoll = { state: "pending"; expiresAt: string } | { state: "approved"; token: string } | { state: "expired" };
/** What the program sees with its secret id; the token is handed over once and the pairing is gone. */
export function pollPairing(id: string, now = Date.now()): PairPoll {
  sweep(now);
  const pairing = pairings.get(id);
  if (!pairing) return { state: "expired" };
  if (!pairing.token) return { state: "pending", expiresAt: new Date(pairing.expiresAt).toISOString() };
  pairings.delete(id);
  return { state: "approved", token: pairing.token };
}

export type PairApproval = { ok: true; host: string } | { ok: false; code: "NODE_PAIR_UNKNOWN" | "NODE_OWNER_ONLY"; message: string };
export function approvePairing(workspaceId: string, typed: string, now = Date.now()): PairApproval {
  sweep(now);
  const store = getStore();
  if (store.getSetting(workspaceId, RUNTIME_OWNER_SETTING) !== "1") {
    return { ok: false, code: "NODE_OWNER_ONLY", message: "目前只有这台服务器运行时的主人账号可以配对算力节点。" };
  }
  const code = normalizePairCode(typed);
  const pairing = [...pairings.values()].find((item) => item.code === code && !item.token);
  if (!pairing) return { ok: false, code: "NODE_PAIR_UNKNOWN", message: "没有这个配对码，或已过期：在那台电脑上重新生成一个。" };
  const token = randomBytes(24).toString("base64url");
  store.setSetting(workspaceId, NODE_TOKEN_SETTING, createHash("sha256").update(token).digest("hex"));
  store.setSetting(workspaceId, NODE_PAIRED_SETTING, JSON.stringify({ host: pairing.host, at: new Date(now).toISOString() }));
  // Pairing is the person saying yes to this computer running the account's model work.
  store.setSetting(workspaceId, NODE_COMPUTE_SETTING, "on");
  pairing.workspaceId = workspaceId;
  pairing.token = token;
  return { ok: true, host: pairing.host };
}

/** 解除配对: the standalone node's token goes, so its next connection is refused; a connected one is let go at its next reconnect. */
export function unpairNode(workspaceId: string): void {
  const store = getStore();
  store.deleteSetting(workspaceId, NODE_TOKEN_SETTING);
  store.deleteSetting(workspaceId, NODE_PAIRED_SETTING);
}

export function pairedNode(workspaceId: string): { host: string; at: string } | null {
  try { return JSON.parse(getStore().getSetting(workspaceId, NODE_PAIRED_SETTING) ?? "null") as { host: string; at: string } | null; } catch { return null; }
}

/** For tests: forget every pending pairing and every address's count. */
export function resetPairings(): void { pairings.clear(); started.clear(); }
