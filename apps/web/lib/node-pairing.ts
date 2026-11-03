import "server-only";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { NODE_COMPUTE_SETTING, NODE_PAIRED_SETTING, NODE_TOKEN_SETTING, normalizePairCode, PAIR_CODE_ALPHABET, PAIR_TTL_MS } from "@crossline/core";
import { readLocale } from "@crossline/db";
import { getStore } from "./crossline";
import { tFor } from "./i18n";

/**
 * Pairing a standalone compute node (docs/compute-node.md, 「Crossline 节点」): the installed program asks for a code without any
 * account (`startPairing`), shows it, and keeps asking with the secret id it was given (`pollPairing`); the person types the code on the
 * 「这台电脑」 card (`approvePairing`), which makes the node its own token and switches 「作为算力节点」 on; the program fetches that token
 * once. Pending pairings live only in this process for ten minutes: a restart loses them and the program asks for a new code.
 *
 * Any signed-in account may approve one for its own workspace (scheme C, 2026-11-03): the token is bound to that workspace and the hub
 * serves that node only that workspace's runs. The node never chooses its workspace; the token does.
 */
/** What the computer says about itself when it asks for a code: shown to the person before they bind it, never checked. */
export type NodeClaims = { host: string; os: string; version: string; shell: boolean };
type Pairing = NodeClaims & { id: string; code: string; expiresAt: number; workspaceId?: string; token?: string };
const pairings = ((globalThis as { crosslineNodePairings?: Map<string, Pairing> }).crosslineNodePairings ??= new Map());
const started = ((globalThis as { crosslineNodePairStarts?: Map<string, number[]> }).crosslineNodePairStarts ??= new Map());
/** Wrong codes typed per account in the last hour (the review of 2026-11-03): a code is not guessed by an account typing at it. */
const failed = ((globalThis as { crosslineNodePairFailures?: Map<string, number[]> }).crosslineNodePairFailures ??= new Map());
const FAILED_PER_ACCOUNT_HOUR = 10;
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

/**
 * The address that connected, as the hosted beta's Caddy saw it: Caddy appends the peer to `X-Forwarded-For` and Next fills the header
 * from the socket only when it is absent, so the right-most entry is the real one and anything before it is the client's own words
 * (the same rule as the public test's `clientIp`, apps/assess/server/security.ts).
 */
export function clientAddress(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",").map((part) => part.trim()).filter(Boolean).pop() || "local";
}

/** Expired pairings go, and so does every address whose last code is over an hour old: the count map no longer grows forever. */
const sweep = (now: number) => {
  for (const [id, pairing] of pairings) if (pairing.expiresAt <= now) pairings.delete(id);
  for (const counts of [started, failed]) for (const [key, times] of counts) {
    const recent = times.filter((at) => now - at < HOUR_MS);
    if (recent.length) counts.set(key, recent); else counts.delete(key);
  }
};
const claim = (value: unknown, max = 60) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "";
const newCode = () => Array.from({ length: 8 }, () => PAIR_CODE_ALPHABET[randomInt(PAIR_CODE_ALPHABET.length)]).join("");
export const showCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

export type PairStart = { ok: true; id: string; code: string; expiresAt: string } | { ok: false; code: "NODE_PAIR_BUSY" };
export function startPairing(address: string, about: { host?: unknown; os?: unknown; version?: unknown; shell?: unknown }, now = Date.now()): PairStart {
  sweep(now);
  const key = addressKey(address);
  const recent = started.get(key) ?? [];
  if (recent.length >= PER_ADDRESS_HOUR || pairings.size >= PENDING_MAX) return { ok: false, code: "NODE_PAIR_BUSY" };
  started.set(key, [...recent, now]);
  let code = newCode();
  while ([...pairings.values()].some((pairing) => pairing.code === code)) code = newCode();
  const pairing: Pairing = { id: randomBytes(24).toString("base64url"), code, host: claim(about.host), os: claim(about.os, 80), version: claim(about.version, 30),
    shell: about.shell === true, expiresAt: now + PAIR_TTL_MS };
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

export type PairApproval = { ok: true; paired: true; host: string } | { ok: true; paired: false; computer: NodeClaims; receives: string[] }
  | { ok: false; code: "NODE_PAIR_UNKNOWN" | "NODE_PAIR_LIMIT"; message: string };
/**
 * Typing a code first only shows the computer behind it — its own host name, system and version — and what it would receive; nothing
 * is bound until the person confirms (`confirm`). A code someone else hands over is how this would be phished, so the step says so.
 */
export function approvePairing(workspaceId: string, typed: string, confirm: boolean, now = Date.now()): PairApproval {
  sweep(now);
  const store = getStore();
  const t = tFor(readLocale(store, workspaceId));
  const misses = failed.get(workspaceId) ?? [];
  if (misses.length >= FAILED_PER_ACCOUNT_HOUR) return { ok: false, code: "NODE_PAIR_LIMIT", message: t("配对码输错太多次，一小时后再试。") };
  const code = normalizePairCode(typed);
  const pairing = [...pairings.values()].find((item) => item.code === code && !item.token);
  if (!pairing) {
    failed.set(workspaceId, [...misses, now]);
    return { ok: false, code: "NODE_PAIR_UNKNOWN", message: t("没有这个配对码，或已过期：在那台电脑上重新生成一个。") };
  }
  if (!confirm) return { ok: true, paired: false, computer: { host: pairing.host, os: pairing.os, version: pairing.version, shell: pairing.shell }, receives: [
    t("这个账号的全部模型运行（访谈、规划、整理、助手）都可能在那台电脑上进行，它能看到运行用到的资料"),
    t("助手每次运行的输入文件会复制一份到那台电脑"),
    pairing.shell ? t("那台电脑已开启「允许在这台电脑上执行命令」：助手会在那台电脑上执行命令")
      : t("那台电脑目前没有开启执行命令；之后在那台电脑上开启，助手就会在那里执行命令")
  ] };
  const token = randomBytes(24).toString("base64url");
  store.setSetting(workspaceId, NODE_TOKEN_SETTING, createHash("sha256").update(token).digest("hex"));
  store.setSetting(workspaceId, NODE_PAIRED_SETTING, JSON.stringify({ host: pairing.host, at: new Date(now).toISOString() }));
  // Pairing is the person saying yes to this computer running the account's model work.
  store.setSetting(workspaceId, NODE_COMPUTE_SETTING, "on");
  pairing.workspaceId = workspaceId;
  pairing.token = token;
  return { ok: true, paired: true, host: pairing.host };
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
export function resetPairings(): void { pairings.clear(); started.clear(); failed.clear(); }
