/**
 * Remote control of the person's own computer from their phone (docs/plans/remote-control-1122.md). Shared by the phone's page, the
 * hosted worker and the computer: what a signed instruction looks like, how the computer checks it, and the codes it refuses with.
 *
 * The phone holds an ECDSA P-256 key it cannot export (WebCrypto, kept in IndexedDB); the computer holds the public halves the person
 * confirmed on the computer's own screen. Every instruction that makes the computer do something is the exact JSON text of an envelope,
 * signed by that key. The hosted server only carries it: changing one byte voids the signature, and an old one is refused as expired or
 * replayed. This file uses WebCrypto only (`globalThis.crypto.subtle`), so the same code runs in the browser and on the computer.
 */

/** The computer's own switch (§7.1): off, only from a signed phone, or also the unattended shell assistant (the old 「开」). */
export type RemoteLevel = "off" | "remote" | "unattended";
export const REMOTE_LEVELS: readonly RemoteLevel[] = ["off", "remote", "unattended"];

/** What a signed instruction asks for. */
export type RemoteKind = "session.start" | "message" | "interrupt" | "session.stop" | "command" | "approve" | "deny" | "folder.read" | "form.submit";
export const REMOTE_KINDS: readonly RemoteKind[] = ["session.start", "message", "interrupt", "session.stop", "command", "approve", "deny", "folder.read", "form.submit"];

export type RemoteEnvelope = {
  v: 1;
  kind: RemoteKind;
  /** The computer it is for (the node's host name): another computer refuses it. */
  computer: string;
  session?: string;
  /** Random, once: a second arrival is refused as replayed. */
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  /** The instruction itself; what the computer does is read from here and nowhere else. */
  payload: Record<string, unknown>;
};

/** An envelope as it travels: its exact text, the signature over that text's UTF-8 bytes, and which phone signed it. */
export type SignedRemote = { key: string; body: string; sig: string };

/** A signed instruction is good for five minutes: one signed while the computer was away is not run when it comes back (§8). */
export const REMOTE_TTL_MS = 5 * 60_000;
/** A phone clock this far ahead is still believed; further and the instruction is refused as not yet valid. */
export const REMOTE_CLOCK_SKEW_MS = 60_000;

/** The refusals the computer answers with (§7.4). `REMOTE_GUARD_DENIED` carries the guard's rule after a colon. */
export const REMOTE_CODES = [
  "REMOTE_DISABLED", "REMOTE_SIGNATURE_INVALID", "REMOTE_SIGNATURE_EXPIRED", "REMOTE_REPLAYED", "REMOTE_PAYLOAD_MISMATCH",
  "REMOTE_WRONG_COMPUTER", "REMOTE_FOLDER_REFUSED", "REMOTE_PATH_REFUSED", "REMOTE_GUARD_DENIED", "NODE_SHELL_REFUSED", "REMOTE_BUSY",
  "REMOTE_RATE_LIMITED", "REMOTE_FORM_REFUSED", "REMOTE_SESSION_CLOSED", "REMOTE_OFFLINE", "REMOTE_PAIRING_REFUSED"
] as const;
export type RemoteCode = typeof REMOTE_CODES[number];

/** How a session's assistant commands are approved (§6.1): every one on the phone (the default), or those inside the folder by themselves. */
export type RemoteApproval = "each" | "auto_in_folder";
export const REMOTE_SESSION_HOURS = { default: 1, max: 8 } as const;

/** Direct commands (§6.2): one at a time, ten minutes at most, 64 KB of output back, 4 KB of it kept, sixty an hour. */
export const REMOTE_COMMAND = { timeoutMs: 10 * 60_000, outputBytes: 64 * 1024, keptBytes: 4 * 1024, perHour: 60 } as const;
/** A file read from an authorised folder (§6.3). */
export const REMOTE_READ_MAX_BYTES = 20 * 1_048_576;
/** A form's screenshot is good for this long before a submit from the phone needs a fresh one (§6.5). */
export const REMOTE_FORM_SHOT_MS = 2 * 60_000;
/** An approval nobody answers is refused after five minutes (§6.1). */
export const REMOTE_APPROVAL_MS = 5 * 60_000;
/** A pairing code is good for ten minutes (§5.1). */
export const REMOTE_PAIR_MS = 10 * 60_000;
/** A session whose computer is away this long ends (§7.2). */
export const REMOTE_AWAY_MS = 10 * 60_000;

const subtle = () => {
  const value = globalThis.crypto?.subtle;
  if (!value) throw new Error("WEBCRYPTO_MISSING");
  return value;
};
const utf8 = (text: string) => new TextEncoder().encode(text);

export function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
}
export function fromBase64(text: string): Uint8Array {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let at = 0; at < raw.length; at += 1) bytes[at] = raw.charCodeAt(at);
  return bytes;
}
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** The SHA-256 of a text (UTF-8) or bytes, as hex. */
export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? utf8(value) : value;
  return hex(new Uint8Array(await subtle().digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)));
}

/**
 * A public key's fingerprint: `id` (the first 32 hex digits of the SHA-256 of its SPKI bytes) names it in a signed instruction; `groups`
 * (six groups of four digits from the same hash) is what the person compares on the phone and on the computer before confirming (§5.1).
 */
export async function fingerprintOf(spkiBase64: string): Promise<{ id: string; groups: string }> {
  const digest = new Uint8Array(await subtle().digest("SHA-256", fromBase64(spkiBase64) as Uint8Array<ArrayBuffer>));
  const groups: string[] = [];
  for (let group = 0; group < 6; group += 1) {
    const at = group * 4;
    const value = (((digest[at] ?? 0) << 24) >>> 0) + ((digest[at + 1] ?? 0) << 16) + ((digest[at + 2] ?? 0) << 8) + (digest[at + 3] ?? 0);
    groups.push(String(value % 10_000).padStart(4, "0"));
  }
  return { id: hex(digest).slice(0, 32), groups: groups.join(" ") };
}

const randomNonce = () => hex(globalThis.crypto.getRandomValues(new Uint8Array(16)));

/** A new envelope, valid for `REMOTE_TTL_MS` from `now`. */
export function newEnvelope(input: { kind: RemoteKind; computer: string; session?: string; payload: Record<string, unknown> }, now = new Date()): RemoteEnvelope {
  return { v: 1, kind: input.kind, computer: input.computer, ...(input.session ? { session: input.session } : {}), nonce: randomNonce(),
    issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + REMOTE_TTL_MS).toISOString(), payload: input.payload };
}

const ECDSA = { name: "ECDSA", hash: "SHA-256" } as const;

/** Signs an envelope with the phone's key (the phone's page). */
export async function signEnvelope(privateKey: CryptoKey, keyId: string, envelope: RemoteEnvelope): Promise<SignedRemote> {
  const body = JSON.stringify(envelope);
  const sig = new Uint8Array(await subtle().sign(ECDSA, privateKey, utf8(body)));
  return { key: keyId, body, sig: toBase64(sig) };
}

export type RemotePhone = { id: string; publicKey: string };
export type RemoteCheck = { ok: true; envelope: RemoteEnvelope; phone: RemotePhone } | { ok: false; code: RemoteCode; envelope?: RemoteEnvelope; phone?: RemotePhone };

const isEnvelope = (value: unknown): value is RemoteEnvelope => {
  const item = value as Partial<RemoteEnvelope> | null;
  return !!item && item.v === 1 && typeof item.kind === "string" && (REMOTE_KINDS as readonly string[]).includes(item.kind)
    && typeof item.computer === "string" && typeof item.nonce === "string" && /^[0-9a-f]{16,64}$/.test(item.nonce)
    && typeof item.issuedAt === "string" && typeof item.expiresAt === "string" && !!item.payload && typeof item.payload === "object" && !Array.isArray(item.payload)
    && (item.session === undefined || typeof item.session === "string");
};

/**
 * The computer's check of a signed instruction (§5.2), in this order: a phone it knows signed exactly this text; it is for this computer;
 * it has not expired (nor was issued in the future); its nonce was not seen before. `seen` answers and remembers a nonce.
 */
export async function verifySigned(signed: unknown, phones: RemotePhone[], context: { computer: string; now: Date; seen: (nonce: string) => boolean }): Promise<RemoteCheck> {
  const value = signed as Partial<SignedRemote> | null;
  if (!value || typeof value.key !== "string" || typeof value.body !== "string" || typeof value.sig !== "string" || value.body.length > 256 * 1024) return { ok: false, code: "REMOTE_SIGNATURE_INVALID" };
  const phone = phones.find((item) => item.id === value.key);
  if (!phone) return { ok: false, code: "REMOTE_SIGNATURE_INVALID" };
  let good = false;
  try {
    const key = await subtle().importKey("spki", fromBase64(phone.publicKey) as Uint8Array<ArrayBuffer>, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    good = await subtle().verify(ECDSA, key, fromBase64(value.sig) as Uint8Array<ArrayBuffer>, utf8(value.body));
  } catch { good = false; }
  if (!good) return { ok: false, code: "REMOTE_SIGNATURE_INVALID", phone };
  let envelope: unknown;
  try { envelope = JSON.parse(value.body); } catch { return { ok: false, code: "REMOTE_SIGNATURE_INVALID", phone }; }
  if (!isEnvelope(envelope)) return { ok: false, code: "REMOTE_SIGNATURE_INVALID", phone };
  if (envelope.computer !== context.computer) return { ok: false, code: "REMOTE_WRONG_COMPUTER", envelope, phone };
  const issued = Date.parse(envelope.issuedAt), expires = Date.parse(envelope.expiresAt), now = context.now.getTime();
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires - issued > REMOTE_TTL_MS || now > expires || issued - now > REMOTE_CLOCK_SKEW_MS)
    return { ok: false, code: "REMOTE_SIGNATURE_EXPIRED", envelope, phone };
  if (context.seen(envelope.nonce)) return { ok: false, code: "REMOTE_REPLAYED", envelope, phone };
  return { ok: true, envelope, phone };
}

/** The code a refusal carries, without the detail after a colon (`REMOTE_GUARD_DENIED:secret.path` → `REMOTE_GUARD_DENIED`). */
export const remoteCodeOf = (text: string): string => text.split(":")[0] ?? text;

/** What the person sees for each refusal, in Chinese (translated where shown). */
export const REMOTE_CODE_WORDS: Record<RemoteCode, string> = {
  REMOTE_DISABLED: "这台电脑没有开启「从手机遥控」",
  REMOTE_SIGNATURE_INVALID: "签名无效，或这部手机已从电脑上移除",
  REMOTE_SIGNATURE_EXPIRED: "指令已过期（超过 5 分钟），请重新发送",
  REMOTE_REPLAYED: "这条指令已经执行过",
  REMOTE_PAYLOAD_MISMATCH: "签名的内容和要执行的内容不一致",
  REMOTE_WRONG_COMPUTER: "这条指令是给另一台电脑的",
  REMOTE_FOLDER_REFUSED: "这个文件夹不在电脑上设定的「遥控可用的文件夹」里",
  REMOTE_PATH_REFUSED: "这个路径不能从手机读取",
  REMOTE_GUARD_DENIED: "守卫拒绝了这条命令",
  NODE_SHELL_REFUSED: "电脑拒绝了这个会话的设置",
  REMOTE_BUSY: "电脑上已有一个进行中的会话",
  REMOTE_RATE_LIMITED: "直接命令每小时最多 60 条",
  REMOTE_FORM_REFUSED: "这份表不能从手机提交（需要付款、截图已过期或字段已变）",
  REMOTE_SESSION_CLOSED: "会话已结束",
  REMOTE_OFFLINE: "电脑不在线",
  REMOTE_PAIRING_REFUSED: "配对码无效或已过期"
};
