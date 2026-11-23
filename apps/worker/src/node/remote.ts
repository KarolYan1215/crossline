// i18n-exempt: the compute node's own words, shown by the standalone node program (bundled alone, without the catalogues; Chinese only)
import { spawn as spawnProcess, spawnSync } from "node:child_process";
import { createHash, randomInt, webcrypto } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { confinedTo, decideCommand, decideFileChange, isSecretPath, type GuardDecision } from "@crossline/core/agent-guard";
import {
  fingerprintOf, fromBase64, REMOTE_APPROVAL_MS, REMOTE_AWAY_MS, REMOTE_COMMAND, REMOTE_PAIR_MS, REMOTE_SESSION_HOURS, verifySigned,
  type RemoteApproval, type RemoteEnvelope, type RemoteLevel, type SignedRemote
} from "@crossline/core/remote-control";
import type { AppServerLines } from "./agent";

/**
 * The computer's end of remote control from the person's phone (docs/plans/remote-control-1122.md). It runs beside the compute node's
 * relay, on its own: a session is a Codex thread this computer starts and drives itself, in a runtime of its own that the hosted server
 * has no line into. The server only carries signed instructions here and events back; what runs is decided here:
 *
 * - every instruction is checked against the phones the person confirmed on this computer (`remote.json`), its expiry and its nonce;
 * - every command the assistant wants goes through this computer's own copy of the guard: a 「拒」 is refused whatever was signed, and
 *   nothing runs without the phone's signed 「执行」 unless the session said 「会话文件夹内自动」 and the command stays in that folder;
 * - everything, refused or done, goes into `remote-audit.jsonl`, a hash chain the server never sees.
 */

export type RemotePhoneRecord = { id: string; label: string; groups: string; publicKey: string; addedAt: string; lastUsedAt?: string };
export type RemoteStore = {
  phones: RemotePhoneRecord[];
  /** A pairing started on this computer's page: its code, and once a phone answered, the key waiting for the person's 「确认」 here. */
  pairing?: { code: string; expiresAt: string; tries: number; candidate?: { id: string; label: string; groups: string; publicKey: string } };
  /** 「遥控可用的文件夹」: where a session may work besides its own folder under the task root. */
  folders: string[];
  /** 「替手机转写录音」 (§6.4), off unless set here. */
  transcribe: boolean;
};

export const remoteFile = (dir: string) => path.join(dir, "remote.json");
export const auditFile = (dir: string) => path.join(dir, "remote-audit.jsonl");
const nonceFile = (dir: string) => path.join(dir, "remote-nonces.json");

export function readRemote(dir: string): RemoteStore {
  try {
    const value = JSON.parse(readFileSync(remoteFile(dir), "utf8")) as Partial<RemoteStore>;
    return { phones: Array.isArray(value.phones) ? value.phones : [], folders: Array.isArray(value.folders) ? value.folders.filter((item) => typeof item === "string") : [],
      transcribe: value.transcribe === true, ...(value.pairing ? { pairing: value.pairing } : {}) };
  } catch { return { phones: [], folders: [], transcribe: false }; }
}
export function writeRemote(dir: string, store: RemoteStore): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(remoteFile(dir), JSON.stringify(store, null, 2));
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The audit log (§7.3): one line per thing, each carrying the hash of the line before it.

export type AuditEntry = { at: string; event: string; ok: boolean; code?: string; session?: string; phone?: string; kind?: string; nonce?: string;
  detail?: Record<string, unknown>; signed?: SignedRemote };
type AuditLine = { prev: string; entry: AuditEntry; hash: string };
const AUDIT_KEEP_DAYS = 180;
const chainHash = (prev: string, entry: AuditEntry) => createHash("sha256").update(`${prev}\n${JSON.stringify(entry)}`).digest("hex");

function auditLines(dir: string): AuditLine[] {
  let text = "";
  try { text = readFileSync(auditFile(dir), "utf8"); } catch { return []; }
  return text.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line) as AuditLine]; } catch { return [{ prev: "", entry: { at: "", event: "unreadable", ok: false }, hash: "" }]; } });
}

export function appendAudit(dir: string, entry: AuditEntry): void {
  mkdirSync(dir, { recursive: true });
  let lines = auditLines(dir);
  // Older than 180 days goes: the first kept line keeps its `prev`, so the chain still checks from there.
  const cutoff = Date.parse(entry.at) - AUDIT_KEEP_DAYS * 86_400_000;
  const first = lines[0];
  if (first && Date.parse(first.entry.at) < cutoff) {
    lines = lines.filter((line) => Date.parse(line.entry.at) >= cutoff);
    writeFileSync(auditFile(dir), lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  }
  const prev = lines.at(-1)?.hash ?? "";
  appendFileSync(auditFile(dir), `${JSON.stringify({ prev, entry, hash: chainHash(prev, entry) })}\n`);
}

/** Whether each line's hash is its own and its `prev` is the line before's; the first broken line (1-based) when not. */
export function verifyAudit(dir: string): { ok: boolean; lines: number; brokenAt?: number } {
  const lines = auditLines(dir);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.hash !== chainHash(line.prev, line.entry) || (index > 0 && line.prev !== lines[index - 1]!.hash)) return { ok: false, lines: lines.length, brokenAt: index + 1 };
  }
  return { ok: true, lines: lines.length };
}

export function readAudit(dir: string, limit = 100): AuditEntry[] {
  return auditLines(dir).slice(-limit).reverse().map((line) => {
    const { signed, ...rest } = line.entry;
    return { ...rest, ...(signed ? { detail: { ...(rest.detail ?? {}), signedBytes: signed.body.length } } : {}) };
  });
}

/** The nonces of instructions this computer took, kept until they expire: a second arrival is a replay, across restarts too. */
function nonceMemory(dir: string, now: () => Date) {
  return (nonce: string, expiresAt: number): boolean => {
    let kept: Record<string, number> = {};
    try { kept = JSON.parse(readFileSync(nonceFile(dir), "utf8")) as Record<string, number>; } catch { kept = {}; }
    const at = now().getTime();
    kept = Object.fromEntries(Object.entries(kept).filter(([, until]) => until > at));
    if (kept[nonce] !== undefined) return true;
    kept[nonce] = expiresAt;
    mkdirSync(dir, { recursive: true });
    writeFileSync(nonceFile(dir), JSON.stringify(kept));
    return false;
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// What the person does on this computer's own page: pair a phone, confirm or remove it, set the folders and the transcription switch.

const isP256Spki = async (publicKey: string) => {
  try { await webcrypto.subtle.importKey("spki", fromBase64(publicKey) as Uint8Array<ArrayBuffer>, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]); return true; } catch { return false; }
};

export type RemoteLocalAction =
  | { pair: "start" | "cancel" } | { confirm: string } | { remove: string } | { folders: unknown } | { transcribe: boolean };

/** One change from this computer's page; the answer is the store as it is now, or why not. */
export function remoteLocalAction(dir: string, action: RemoteLocalAction, now = new Date()): { ok: true; store: RemoteStore } | { ok: false; code: string; message: string } {
  const store = readRemote(dir);
  if ("pair" in action) {
    if (action.pair === "cancel") { delete store.pairing; writeRemote(dir, store); appendAudit(dir, { at: now.toISOString(), event: "pair.cancelled", ok: true }); return { ok: true, store }; }
    store.pairing = { code: String(randomInt(0, 100_000_000)).padStart(8, "0"), expiresAt: new Date(now.getTime() + REMOTE_PAIR_MS).toISOString(), tries: 0 };
    writeRemote(dir, store);
    appendAudit(dir, { at: now.toISOString(), event: "pair.started", ok: true });
    return { ok: true, store };
  }
  if ("confirm" in action) {
    const candidate = store.pairing?.candidate;
    if (!candidate || candidate.id !== action.confirm || Date.parse(store.pairing!.expiresAt) < now.getTime()) return { ok: false, code: "REMOTE_PAIRING_REFUSED", message: "配对已过期，请重新添加" };
    store.phones = [...store.phones.filter((phone) => phone.id !== candidate.id), { ...candidate, addedAt: now.toISOString() }];
    delete store.pairing;
    writeRemote(dir, store);
    appendAudit(dir, { at: now.toISOString(), event: "phone.added", ok: true, phone: candidate.id.slice(0, 8), detail: { label: candidate.label, groups: candidate.groups } });
    return { ok: true, store };
  }
  if ("remove" in action) {
    const removed = store.phones.find((phone) => phone.id === action.remove);
    store.phones = store.phones.filter((phone) => phone.id !== action.remove);
    writeRemote(dir, store);
    if (removed) appendAudit(dir, { at: now.toISOString(), event: "phone.removed", ok: true, phone: removed.id.slice(0, 8), detail: { label: removed.label } });
    return { ok: true, store };
  }
  if ("folders" in action) {
    const given = Array.isArray(action.folders) ? action.folders.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];
    for (const folder of given) {
      const why = workFolderProblem(folder);
      if (why) return { ok: false, code: "REMOTE_FOLDER_REFUSED", message: why };
    }
    store.folders = [...new Set(given.map((folder) => path.resolve(folder)))].slice(0, 20);
    writeRemote(dir, store);
    appendAudit(dir, { at: now.toISOString(), event: "folders.set", ok: true, detail: { folders: store.folders } });
    return { ok: true, store };
  }
  store.transcribe = action.transcribe === true;
  writeRemote(dir, store);
  appendAudit(dir, { at: now.toISOString(), event: "transcribe.set", ok: true, detail: { on: store.transcribe } });
  return { ok: true, store };
}

/** Why a folder cannot be a session's working folder: not absolute, missing, a drive root or the whole home, or where keys live. */
export function workFolderProblem(folder: string, home = process.env.USERPROFILE ?? process.env.HOME ?? ""): string | undefined {
  if (!path.isAbsolute(folder)) return `「${folder}」不是完整路径`;
  const resolved = path.resolve(folder);
  if (resolved === path.parse(resolved).root || (home && path.resolve(home) === resolved)) return "不能把整个磁盘或整个用户目录交给遥控";
  if (isSecretPath(resolved) || isSecretPath(`${resolved}${path.sep}x`)) return "这是凭据所在的位置";
  try { if (!statSync(resolved).isDirectory()) return `「${folder}」不是文件夹`; } catch { return `找不到「${folder}」`; }
  return undefined;
}

/** What this computer's page shows (phones without their keys). */
export function remoteLocalView(dir: string, now = new Date()) {
  const store = readRemote(dir);
  const pairing = store.pairing && Date.parse(store.pairing.expiresAt) > now.getTime() ? store.pairing : undefined;
  return {
    phones: store.phones.map(({ publicKey: _key, ...phone }) => phone),
    pairing: pairing ? { code: pairing.code, expiresAt: pairing.expiresAt, ...(pairing.candidate ? { candidate: { id: pairing.candidate.id, label: pairing.candidate.label, groups: pairing.candidate.groups } } : {}) } : null,
    folders: store.folders, transcribe: store.transcribe, audit: readAudit(dir, 60), chain: verifyAudit(dir)
  };
}

/**
 * 「核对」 (§7.3): the hosted ledger's `remote.*` events of the last seven days whose signed instruction this computer has no record of.
 * Events without a nonce (things the computer itself reported) are not instructions and are not compared.
 */
export function reconcileAudit(dir: string, ledger: Array<{ type: string; at: string; nonce?: string; session?: string }>, now = new Date()) {
  const since = now.getTime() - 7 * 86_400_000;
  const known = new Set(auditLines(dir).filter((line) => line.entry.ok && line.entry.nonce).map((line) => line.entry.nonce));
  return ledger.filter((event) => event.nonce && Date.parse(event.at) >= since && !known.has(event.nonce));
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The controller.

export type RemoteEvent = { type: string; at: string; session?: string; phone?: string; nonce?: string } & Record<string, unknown>;
export type RemoteRequest =
  | { op: "signed"; signed: SignedRemote }
  | { op: "pair"; code: string; publicKey: string; label: string }
  | { op: "status" }
  | { op: "folders"; folder?: string; dir?: string; page?: number }
  | { op: "transcribe"; name: string; data: string };
export type RemoteAnswer = ({ ok: true } & Record<string, unknown>) | { ok: false; code: string; reason?: string };

/** What only some computers have: a linked device's authorised folders and transcriber, a browser holding a registration form. */
export type RemoteHooks = {
  folders?: {
    list: (folder: string | undefined, dir: string, page: number) => Promise<{ ok: true; text: string } | { ok: false; message: string }>;
    read: (folder: string, relative: string, as: "text" | "file" | "save") => Promise<{ ok: true; name: string; size: number; text?: string; data?: Buffer; contentType?: string } | { ok: false; message: string }>;
  };
  transcribe?: (bytes: Buffer, name: string) => Promise<{ state: string; text?: string; seconds?: number; speechSeconds?: number; workMs?: number }>;
  forms?: { submit: (input: { shot: string; button: { role: string; name: string } }) => Promise<{ ok: true; picture?: Buffer } | { ok: false; why: string }> };
};

export type CommandResult = { exitCode: number | null; output: string; truncated: boolean; timedOut: boolean };
export type CommandRunner = (command: string, cwd: string, signal: AbortSignal) => Promise<CommandResult>;

export type RemoteControlOptions = {
  /** Where `remote.json` and the audit log live (`<data>/device`, or the standalone node's own folder). */
  dir: string;
  /** This computer's name, as the phone signs it. */
  computer: string;
  level: RemoteLevel;
  /** Sessions without a chosen folder work in `<tasksRoot>/remote-<id>`. */
  tasksRoot: string;
  home: string;
  /** A Codex runtime of its own for each session. */
  spawn: () => AppServerLines;
  hooks?: RemoteHooks;
  log?: (event: Record<string, unknown>) => void;
  now?: () => Date;
  run?: CommandRunner;
};

type Pending = { id: string; command: string; sha: string; kind: "command" | "fileChange"; resolve: (accept: boolean) => void; timer: ReturnType<typeof setTimeout> };
type Session = {
  id: string; folder: string; approval: RemoteApproval; endsAt: number; phone: string;
  runtime: AppServerLines; rpc: ReturnType<typeof rpcOver>; threadId: string; turnId?: string | undefined;
  pending: Map<string, Pending>; changes: Map<string, string[]>; command?: AbortController | undefined; timer: ReturnType<typeof setTimeout>;
};

const SESSION_ID = /^[a-z0-9][a-z0-9-]{5,63}$/;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const cut = (text: string, bytes: number) => { const buffer = Buffer.from(text); return buffer.length <= bytes ? text : buffer.subarray(0, bytes).toString("utf8"); };

/* i18n-ignore-start: instructions to the model */
const INSTRUCTIONS = [
  "你在本人自己的电脑上工作，是本人从手机上发起的远程会话。工作文件夹就是当前目录。",
  "每条命令都可能要本人在手机上批准后才执行；被拒绝时换一种做法，或者告诉本人需要什么。",
  "不读写凭据、密钥、浏览器登录数据；不付款、不发送邮件或消息、不发布任何内容；这些一律由本人自己完成。",
  "回答要短：本人在手机上读。做完一步说一句结果；需要本人决定的，直接问。"
].join("\n");
/* i18n-ignore-end */

/** The child's environment without anything named like a key, and without Codex's and Crossline's own variables (as `NODE_RUNTIME_FLAGS`). */
export function commandEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD|^CODEX_HOME$|^CROSSLINE_/i.test(name)));
}

/** A direct command (§6.2): PowerShell on Windows, `sh` elsewhere, in the folder, its output kept to 64 KB, killed after ten minutes. */
export const runCommand: CommandRunner = (command, cwd, signal) => new Promise((resolve) => {
  const windows = process.platform === "win32";
  const child = spawnProcess(windows ? "powershell.exe" : "/bin/sh", windows ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-c", command],
    { cwd, env: commandEnvironment(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  let size = 0, truncated = false, timedOut = false;
  const take = (chunk: Buffer) => {
    if (size >= REMOTE_COMMAND.outputBytes) { truncated = true; return; }
    const part = chunk.subarray(0, REMOTE_COMMAND.outputBytes - size);
    if (part.length < chunk.length) truncated = true;
    chunks.push(part); size += part.length;
  };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  const kill = () => {
    if (child.exitCode !== null || !child.pid) return;
    if (windows) spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true }); else child.kill("SIGKILL");
  };
  const timer = setTimeout(() => { timedOut = true; kill(); }, REMOTE_COMMAND.timeoutMs);
  signal.addEventListener("abort", kill, { once: true });
  const done = (exitCode: number | null) => { clearTimeout(timer); resolve({ exitCode, output: Buffer.concat(chunks).toString("utf8"), truncated, timedOut }); };
  child.on("error", () => done(null));
  child.on("close", (code) => done(code));
});

/** JSON-RPC over a runtime's lines: requests out, its notifications and its own requests (approvals) in. */
function rpcOver(lines: AppServerLines, handlers: { notify: (method: string, params: Record<string, unknown>) => void; request: (method: string, params: Record<string, unknown>) => Promise<unknown> }) {
  let next = 0;
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  lines.onLine((line) => {
    let message: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { message?: unknown } };
    try { message = JSON.parse(line) as typeof message; } catch { return; }
    const params = (message.params && typeof message.params === "object" ? message.params : {}) as Record<string, unknown>;
    if (typeof message.method === "string" && message.id !== undefined) {
      const id = message.id;
      void handlers.request(message.method, params).then((result) => lines.write(JSON.stringify({ id, result })))
        .catch((error: unknown) => lines.write(JSON.stringify({ id, error: { code: -32000, message: error instanceof Error ? error.message : "REFUSED" } })));
      return;
    }
    if (typeof message.method === "string") { handlers.notify(message.method, params); return; }
    const waiting = pending.get(String(message.id));
    if (!waiting) return;
    pending.delete(String(message.id));
    if (message.error) waiting.reject(new Error(String(message.error.message ?? "RPC_FAILED"))); else waiting.resolve(message.result);
  });
  lines.onExit(() => { for (const waiting of pending.values()) waiting.reject(new Error("RUNTIME_EXITED")); pending.clear(); });
  return {
    request: (method: string, params: unknown, timeoutMs = 60_000) => new Promise<unknown>((resolve, reject) => {
      const id = `remote-${++next}`;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("RPC_TIMEOUT")); }, timeoutMs);
      pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      lines.write(JSON.stringify({ id, method, params }));
    }),
    notify: (method: string, params?: unknown) => lines.write(JSON.stringify({ method, ...(params ? { params } : {}) }))
  };
}

const record = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined);

export function createRemoteControl(options: RemoteControlOptions) {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const run = options.run ?? runCommand;
  const seen = nonceMemory(options.dir, now);
  let session: Session | undefined;
  let send: ((event: RemoteEvent) => void) | undefined;
  const buffered: RemoteEvent[] = [];
  let away: ReturnType<typeof setTimeout> | undefined;
  const commandTimes: number[] = [];

  const emit = (event: Omit<RemoteEvent, "at">) => {
    const full = { ...event, at: now().toISOString() } as RemoteEvent;
    if (send) send(full); else if (buffered.length < 500) buffered.push(full);
  };
  const audit = (entry: Omit<AuditEntry, "at">) => { try { appendAudit(options.dir, { ...entry, at: now().toISOString() }); } catch (error) { log({ type: "remote.audit_failed", message: String(error).slice(0, 200) }); } };
  const refuse = (code: string, context: { envelope?: RemoteEnvelope; phone?: string; signed?: SignedRemote; reason?: string; event?: string }): RemoteAnswer => {
    audit({ event: context.event ?? "refused", ok: false, code, ...(context.envelope ? { kind: context.envelope.kind, nonce: context.envelope.nonce, ...(context.envelope.session ? { session: context.envelope.session } : {}) } : {}),
      ...(context.phone ? { phone: context.phone } : {}), ...(context.signed ? { signed: context.signed } : {}), ...(context.reason ? { detail: { reason: context.reason } } : {}) });
    emit({ type: "refused", code, ...(context.envelope?.session ? { session: context.envelope.session } : {}), ...(context.envelope ? { kind: context.envelope.kind, nonce: context.envelope.nonce } : {}),
      ...(context.reason ? { reason: context.reason.slice(0, 300) } : {}) });
    return { ok: false, code, ...(context.reason ? { reason: context.reason } : {}) };
  };

  const endSession = (reason: string) => {
    const ending = session;
    if (!ending) return;
    session = undefined;
    clearTimeout(ending.timer);
    for (const waiting of ending.pending.values()) { clearTimeout(waiting.timer); waiting.resolve(false); }
    ending.command?.abort();
    if (ending.turnId) void ending.rpc.request("turn/interrupt", { threadId: ending.threadId, turnId: ending.turnId }, 5_000).catch(() => undefined);
    setTimeout(() => ending.runtime.stop(), 1_000);
    audit({ event: "session.ended", ok: true, session: ending.id, detail: { reason } });
    emit({ type: "session.ended", session: ending.id, reason });
  };

  /** One request from the runtime of a session: a command or a file change, answered by the guard here and, when needed, the phone. */
  const approve = async (current: Session, method: string, params: Record<string, unknown>): Promise<unknown> => {
    const context = { taskDir: current.folder, homeDir: options.home };
    let subject: string, decision: GuardDecision, kind: Pending["kind"], confined: boolean;
    if (method === "item/commandExecution/requestApproval") {
      subject = typeof params.command === "string" ? params.command : JSON.stringify(params.command ?? "");
      kind = "command";
      if ((params.kind && params.kind !== "command") || params.additionalPermissions) decision = { decision: "deny", rule: "permissions.extra", reason: "不授予额外权限" };
      else decision = decideCommand(subject, context);
      confined = confinedTo(subject, [current.folder]);
    } else if (method === "item/fileChange/requestApproval") {
      const paths = current.changes.get(String(params.itemId ?? "")) ?? [];
      subject = paths.join("; ");
      kind = "fileChange";
      decision = params.grantRoot || !paths.length ? { decision: "deny", rule: "write.unverifiable", reason: "无法确认要改的文件都在会话文件夹里" } : decideFileChange(paths, context);
      confined = decision.decision === "allow";
    } else if (method === "mcpServer/elicitation/request") {
      return { action: "decline", content: null, _meta: null };
    } else throw new Error(`REFUSED: ${method}`);
    if (decision.decision === "deny") {
      audit({ event: "approval.refused", ok: false, code: `REMOTE_GUARD_DENIED:${decision.rule}`, session: current.id, kind, detail: { subject: cut(subject, 2_000), reason: decision.reason } });
      emit({ type: "approval.refused", session: current.id, kind, subject: cut(subject, 2_000), rule: decision.rule, reason: decision.reason });
      return { decision: "decline" };
    }
    // 「会话文件夹内自动」 is decided here, not by the server: allowed by this computer's guard and staying in the session's folder.
    if (current.approval === "auto_in_folder" && decision.decision === "allow" && confined) {
      audit({ event: "approval.auto", ok: true, session: current.id, kind, detail: { subject: cut(subject, 2_000) } });
      return { decision: "accept" };
    }
    const id = String(params.itemId ?? `approval-${Date.now()}`).slice(0, 80);
    const accepted = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        current.pending.delete(id);
        audit({ event: "approval.expired", ok: false, session: current.id, kind, detail: { subject: cut(subject, 2_000) } });
        emit({ type: "approval.expired", session: current.id, approval: id });
        resolve(false);
      }, REMOTE_APPROVAL_MS);
      current.pending.set(id, { id, command: subject, sha: sha256(subject), kind, resolve, timer });
      emit({ type: "approval.asked", session: current.id, approval: id, kind, subject: cut(subject, 4_000), sha: sha256(subject), cwd: String(params.cwd ?? current.folder),
        rule: decision.rule, reason: decision.reason, expiresAt: new Date(now().getTime() + REMOTE_APPROVAL_MS).toISOString() });
    });
    return { decision: accepted ? "accept" : "decline" };
  };

  const onNotify = (current: Session, method: string, params: Record<string, unknown>) => {
    if (session !== current) return;
    if (method === "turn/started") { current.turnId = String(record(params.turn)?.id ?? ""); emit({ type: "turn.started", session: current.id }); return; }
    if (method === "turn/completed") {
      current.turnId = undefined;
      emit({ type: "turn.completed", session: current.id, status: String(record(params.turn)?.status ?? "") });
      return;
    }
    if (method === "item/agentMessage/delta") { emit({ type: "delta", session: current.id, item: String(params.itemId ?? ""), text: String(params.delta ?? "").slice(0, 4_000), live: true }); return; }
    if (method !== "item/started" && method !== "item/completed") return;
    const item = record(params.item);
    if (!item) return;
    const type = String(item.type ?? "");
    if (type === "fileChange") {
      const changes = Array.isArray(item.changes) ? item.changes as Array<Record<string, unknown>> : [];
      const paths = changes.map((change) => String(change.path ?? "")).filter(Boolean);
      if (typeof item.id === "string" && paths.length) current.changes.set(item.id, paths);
      if (method === "item/completed") {
        const hashed = paths.slice(0, 60).map((file) => { try { return { path: file, sha: createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16) }; } catch { return { path: file }; } });
        audit({ event: "files.changed", ok: true, session: current.id, detail: { files: hashed } });
        emit({ type: "files.changed", session: current.id, files: hashed });
      }
    } else if (type === "commandExecution") {
      if (method === "item/started") emit({ type: "command.started", session: current.id, item: String(item.id ?? ""), command: cut(String(item.command ?? ""), 2_000), live: true });
      else {
        const output = String(item.aggregatedOutput ?? "");
        audit({ event: "command.ran", ok: true, session: current.id, detail: { command: cut(String(item.command ?? ""), 2_000), exitCode: item.exitCode ?? null } });
        emit({ type: "command.completed", session: current.id, item: String(item.id ?? ""), command: cut(String(item.command ?? ""), 2_000), exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
          output: cut(output, REMOTE_COMMAND.keptBytes), truncated: Buffer.byteLength(output) > REMOTE_COMMAND.keptBytes });
      }
    } else if (type === "agentMessage" && method === "item/completed") {
      emit({ type: "message.assistant", session: current.id, item: String(item.id ?? ""), text: cut(String(item.text ?? ""), 32_000) });
    }
  };

  const startSession = async (envelope: RemoteEnvelope, phone: string): Promise<RemoteAnswer> => {
    const id = envelope.session ?? "";
    if (!SESSION_ID.test(id)) return refuse("REMOTE_PAYLOAD_MISMATCH", { envelope, phone, reason: "session id" });
    if (session) return refuse("REMOTE_BUSY", { envelope, phone });
    const payload = envelope.payload as { folder?: unknown; approval?: unknown; hours?: unknown };
    const store = readRemote(options.dir);
    let folder: string;
    if (typeof payload.folder === "string" && payload.folder) {
      const wanted = path.resolve(payload.folder);
      if (!store.folders.some((item) => path.resolve(item) === wanted) || workFolderProblem(wanted, options.home)) return refuse("REMOTE_FOLDER_REFUSED", { envelope, phone });
      folder = wanted;
    } else {
      folder = path.join(options.tasksRoot, `remote-${id}`);
      mkdirSync(folder, { recursive: true });
    }
    const approval: RemoteApproval = payload.approval === "auto_in_folder" ? "auto_in_folder" : "each";
    const hours = Math.min(REMOTE_SESSION_HOURS.max, Math.max(0.25, Number(payload.hours) || REMOTE_SESSION_HOURS.default));
    const runtime = options.spawn();
    // The session object exists before the runtime answers, so its requests (which name the session) always find it.
    const current = { id, folder, approval, endsAt: now().getTime() + hours * 3_600_000, phone, runtime, threadId: "", pending: new Map(), changes: new Map() } as unknown as Session;
    current.rpc = rpcOver(runtime, { notify: (method, params) => onNotify(current, method, params), request: (method, params) => approve(current, method, params) });
    runtime.onExit(() => { if (session === current) endSession("runtime_exited"); });
    try {
      await current.rpc.request("initialize", { clientInfo: { name: "crossline", title: "Crossline", version: "0.1.0" }, capabilities: { experimentalApi: true, requestAttestation: false } });
      current.rpc.notify("initialized");
      const started = record(await current.rpc.request("thread/start", { cwd: folder, sandbox: "danger-full-access", approvalPolicy: "untrusted", approvalsReviewer: "user", developerInstructions: INSTRUCTIONS }));
      // Under `untrusted`, every command off the runtime's short harmless list comes back here; anything else is not started.
      if (started?.approvalPolicy !== "untrusted") { runtime.stop(); return refuse("NODE_SHELL_REFUSED", { envelope, phone, reason: "approval" }); }
      current.threadId = String(record(started.thread)?.id ?? "");
      if (!current.threadId) throw new Error("NO_THREAD");
    } catch (error) {
      runtime.stop();
      return refuse("NODE_SHELL_REFUSED", { envelope, phone, reason: error instanceof Error ? error.message.slice(0, 200) : "start" });
    }
    current.timer = setTimeout(() => endSession("expired"), current.endsAt - now().getTime());
    session = current;
    audit({ event: "session.started", ok: true, session: id, phone, kind: envelope.kind, nonce: envelope.nonce, detail: { folder, approval, hours } });
    emit({ type: "session.started", session: id, phone, nonce: envelope.nonce, folder, approval, endsAt: new Date(current.endsAt).toISOString() });
    return { ok: true, session: id, folder, approval, endsAt: new Date(current.endsAt).toISOString() };
  };

  const inSession = (envelope: RemoteEnvelope) => session && envelope.session === session.id ? session : undefined;

  const directCommand = async (envelope: RemoteEnvelope, phone: string, signed: SignedRemote): Promise<RemoteAnswer> => {
    const current = inSession(envelope);
    if (!current) return refuse("REMOTE_SESSION_CLOSED", { envelope, phone });
    const text = typeof envelope.payload.text === "string" ? envelope.payload.text.trim() : "";
    if (!text || text.length > 8_000) return refuse("REMOTE_PAYLOAD_MISMATCH", { envelope, phone });
    // The guard's 「拒」 holds for the person's own command too: its output goes through the server (§6.2, decided 2026-11-22).
    const decision = decideCommand(text, { taskDir: current.folder, homeDir: options.home });
    if (decision.decision === "deny") return refuse(`REMOTE_GUARD_DENIED:${decision.rule}`, { envelope, phone, signed, reason: decision.reason });
    if (decision.decision === "ask" && envelope.payload.confirm !== true) {
      audit({ event: "command.needs_confirm", ok: true, session: current.id, phone, nonce: envelope.nonce, detail: { command: cut(text, 2_000), rule: decision.rule } });
      return { ok: true, state: "needs_confirm", rule: decision.rule, reason: decision.reason };
    }
    if (current.command) return refuse("REMOTE_BUSY", { envelope, phone });
    const hour = now().getTime() - 3_600_000;
    while (commandTimes.length && commandTimes[0]! < hour) commandTimes.shift();
    if (commandTimes.length >= REMOTE_COMMAND.perHour) return refuse("REMOTE_RATE_LIMITED", { envelope, phone });
    commandTimes.push(now().getTime());
    const controller = new AbortController();
    current.command = controller;
    audit({ event: "command.direct", ok: true, session: current.id, phone, kind: envelope.kind, nonce: envelope.nonce, signed, detail: { command: cut(text, 2_000), rule: decision.rule } });
    emit({ type: "command.started", session: current.id, direct: true, command: cut(text, 2_000), nonce: envelope.nonce, phone, live: true });
    const result = await run(text, current.folder, controller.signal).finally(() => { if (current.command === controller) current.command = undefined; });
    audit({ event: "command.direct_done", ok: true, session: current.id, nonce: envelope.nonce, detail: { exitCode: result.exitCode, timedOut: result.timedOut, sha: sha256(result.output) } });
    emit({ type: "command.completed", session: current.id, direct: true, nonce: envelope.nonce, command: cut(text, 2_000), exitCode: result.exitCode, timedOut: result.timedOut,
      output: cut(result.output, REMOTE_COMMAND.keptBytes), truncated: result.truncated || Buffer.byteLength(result.output) > REMOTE_COMMAND.keptBytes });
    return { ok: true, state: "done", exitCode: result.exitCode, timedOut: result.timedOut, output: result.output, truncated: result.truncated };
  };

  const signedOp = async (signed: SignedRemote): Promise<RemoteAnswer> => {
    if (options.level === "off") return refuse("REMOTE_DISABLED", { signed });
    const store = readRemote(options.dir);
    const check = await verifySigned(signed, store.phones, { computer: options.computer, now: now(), seen: (nonce) => seen(nonce, now().getTime() + 6 * 60_000) });
    if (!check.ok) return refuse(check.code, { ...(check.envelope ? { envelope: check.envelope } : {}), ...(check.phone ? { phone: check.phone.id.slice(0, 8) } : {}), signed });
    const { envelope } = check;
    const phone = check.phone.id.slice(0, 8);
    const kept = readRemote(options.dir);
    kept.phones = kept.phones.map((item) => item.id === check.phone.id ? { ...item, lastUsedAt: now().toISOString() } : item);
    writeRemote(options.dir, kept);
    const done = (event: string, detail?: Record<string, unknown>) => audit({ event, ok: true, phone, kind: envelope.kind, nonce: envelope.nonce, signed,
      ...(envelope.session ? { session: envelope.session } : {}), ...(detail ? { detail } : {}) });
    switch (envelope.kind) {
      case "session.start": return startSession(envelope, phone);
      case "message": {
        const current = inSession(envelope);
        if (!current) return refuse("REMOTE_SESSION_CLOSED", { envelope, phone });
        const text = typeof envelope.payload.text === "string" ? envelope.payload.text.trim().slice(0, 20_000) : "";
        if (!text) return refuse("REMOTE_PAYLOAD_MISMATCH", { envelope, phone });
        if (current.turnId) return refuse("REMOTE_BUSY", { envelope, phone, reason: "turn" });
        done("message");
        emit({ type: "message.person", session: current.id, text, nonce: envelope.nonce, phone });
        try { await current.rpc.request("turn/start", { threadId: current.threadId, input: [{ type: "text", text, text_elements: [] }] }); }
        catch (error) { return refuse("REMOTE_SESSION_CLOSED", { envelope, phone, reason: error instanceof Error ? error.message.slice(0, 200) : "turn" }); }
        return { ok: true };
      }
      case "interrupt": {
        const current = inSession(envelope);
        if (!current) return refuse("REMOTE_SESSION_CLOSED", { envelope, phone });
        done("interrupt");
        current.command?.abort();
        for (const waiting of current.pending.values()) { clearTimeout(waiting.timer); waiting.resolve(false); }
        current.pending.clear();
        if (current.turnId) await current.rpc.request("turn/interrupt", { threadId: current.threadId, turnId: current.turnId }, 10_000).catch(() => undefined);
        emit({ type: "interrupted", session: current.id, nonce: envelope.nonce });
        return { ok: true };
      }
      case "session.stop": {
        if (!inSession(envelope)) return refuse("REMOTE_SESSION_CLOSED", { envelope, phone });
        done("session.stop");
        endSession("person");
        return { ok: true };
      }
      case "approve": case "deny": {
        const current = inSession(envelope);
        if (!current) return refuse("REMOTE_SESSION_CLOSED", { envelope, phone });
        const waiting = current.pending.get(String(envelope.payload.approval ?? ""));
        if (!waiting) return refuse("REMOTE_SESSION_CLOSED", { envelope, phone, reason: "approval" });
        // What was signed must be the command that waits: a server that swapped the command shown on the phone gets a refusal.
        if (envelope.payload.sha !== waiting.sha) return refuse("REMOTE_PAYLOAD_MISMATCH", { envelope, phone, signed });
        clearTimeout(waiting.timer);
        current.pending.delete(waiting.id);
        done(envelope.kind === "approve" ? "approval.accepted" : "approval.declined", { subject: cut(waiting.command, 2_000) });
        emit({ type: "approval.resolved", session: current.id, approval: waiting.id, accepted: envelope.kind === "approve", nonce: envelope.nonce, phone });
        waiting.resolve(envelope.kind === "approve");
        return { ok: true };
      }
      case "command": return directCommand(envelope, phone, signed);
      case "folder.read": {
        if (!options.hooks?.folders) return refuse("REMOTE_PATH_REFUSED", { envelope, phone, reason: "no authorised folders here" });
        const folder = String(envelope.payload.folder ?? ""), relative = String(envelope.payload.path ?? "");
        const as = envelope.payload.as === "file" ? "file" : envelope.payload.as === "save" ? "save" : "text";
        if (!folder || !relative || relative.split(/[\\/]+/).includes("..")) return refuse("REMOTE_PATH_REFUSED", { envelope, phone });
        const read = await options.hooks.folders.read(folder, relative, as);
        if (!read.ok) return refuse("REMOTE_PATH_REFUSED", { envelope, phone, reason: read.message });
        done("folder.read", { folder, path: relative, as, size: read.size, ...(read.data ? { sha: createHash("sha256").update(read.data).digest("hex") } : {}) });
        emit({ type: "folder.read", folder, path: relative, as, size: read.size, nonce: envelope.nonce, phone });
        return { ok: true, name: read.name, size: read.size, ...(read.text !== undefined ? { text: read.text } : {}), ...(read.data ? { data: read.data.toString("base64"), contentType: read.contentType ?? "application/octet-stream" } : {}) };
      }
      case "form.submit": {
        if (!options.hooks?.forms) return refuse("REMOTE_FORM_REFUSED", { envelope, phone, reason: "no form here" });
        const button = record(envelope.payload.button);
        const shot = String(envelope.payload.shot ?? "");
        if (!button || typeof button.name !== "string" || typeof button.role !== "string" || !/^[0-9a-f]{64}$/.test(shot)) return refuse("REMOTE_FORM_REFUSED", { envelope, phone });
        const submitted = await options.hooks.forms.submit({ shot, button: { role: button.role, name: button.name } });
        if (!submitted.ok) return refuse("REMOTE_FORM_REFUSED", { envelope, phone, signed, reason: submitted.why });
        done("form.submitted", { run: envelope.payload.run ?? null, button: button.name, shot });
        emit({ type: "form.submitted", run: String(envelope.payload.run ?? ""), nonce: envelope.nonce, phone });
        return { ok: true, ...(submitted.picture ? { picture: submitted.picture.toString("base64") } : {}) };
      }
    }
    return refuse("REMOTE_PAYLOAD_MISMATCH", { envelope, phone, signed });
  };

  const status = () => {
    const store = readRemote(options.dir);
    return { level: options.level, computer: options.computer, phones: store.phones.length, folders: store.folders, transcribe: store.transcribe && Boolean(options.hooks?.transcribe),
      authorised: Boolean(options.hooks?.folders), forms: Boolean(options.hooks?.forms),
      session: session ? { id: session.id, folder: session.folder, approval: session.approval, endsAt: new Date(session.endsAt).toISOString(), busy: Boolean(session.turnId || session.command),
        pending: [...session.pending.values()].map((item) => ({ approval: item.id, kind: item.kind, subject: cut(item.command, 4_000), sha: item.sha })) } : null };
  };

  return {
    handle: async (request: RemoteRequest): Promise<RemoteAnswer> => {
      try {
        if (request.op === "status") return { ok: true, ...status() };
        if (options.level === "off") return { ok: false, code: "REMOTE_DISABLED" };
        if (request.op === "signed") return await signedOp(request.signed);
        if (request.op === "pair") {
          const store = readRemote(options.dir);
          const pairing = store.pairing;
          if (!pairing || Date.parse(pairing.expiresAt) < now().getTime() || pairing.tries >= 5) return refuse("REMOTE_PAIRING_REFUSED", { event: "pair.refused" });
          pairing.tries += 1;
          if (String(request.code) !== pairing.code || typeof request.publicKey !== "string" || !(await isP256Spki(request.publicKey))) {
            writeRemote(options.dir, store);
            return refuse("REMOTE_PAIRING_REFUSED", { event: "pair.refused" });
          }
          const print = await fingerprintOf(request.publicKey);
          pairing.candidate = { id: print.id, groups: print.groups, publicKey: request.publicKey, label: String(request.label ?? "").slice(0, 60) || "手机" };
          writeRemote(options.dir, store);
          audit({ event: "pair.offered", ok: true, phone: print.id.slice(0, 8), detail: { groups: print.groups, label: pairing.candidate.label } });
          return { ok: true, groups: print.groups, id: print.id };
        }
        if (request.op === "folders") {
          if (!options.hooks?.folders) return { ok: false, code: "REMOTE_PATH_REFUSED", reason: "no authorised folders here" };
          const listed = await options.hooks.folders.list(request.folder, String(request.dir ?? ""), Math.max(0, Number(request.page) || 0));
          return listed.ok ? { ok: true, text: listed.text } : { ok: false, code: "REMOTE_PATH_REFUSED", reason: listed.message };
        }
        if (request.op === "transcribe") {
          if (!options.hooks?.transcribe || !readRemote(options.dir).transcribe) return { ok: false, code: "REMOTE_DISABLED", reason: "transcribe" };
          const bytes = Buffer.from(String(request.data ?? ""), "base64");
          const result = await options.hooks.transcribe(bytes, path.basename(String(request.name ?? "recording")));
          audit({ event: "recording.transcribed", ok: result.state === "transcribed" || result.state === "silent", detail: { state: result.state, sha: createHash("sha256").update(bytes).digest("hex"), seconds: result.seconds ?? null } });
          return { ok: true, state: result.state, text: result.text ?? "", seconds: result.seconds ?? 0, speechSeconds: result.speechSeconds ?? 0, workMs: result.workMs ?? 0 };
        }
        return { ok: false, code: "REMOTE_PAYLOAD_MISMATCH" };
      } catch (error) {
        log({ type: "remote.failed", message: error instanceof Error ? error.message.slice(0, 200) : String(error) });
        return { ok: false, code: "REMOTE_FAILED", reason: error instanceof Error ? error.message.slice(0, 200) : "" };
      }
    },
    /** The connection to the site came (back): what happened meanwhile goes first. */
    attached: (deliver: (event: RemoteEvent) => void) => {
      if (away) { clearTimeout(away); away = undefined; }
      send = deliver;
      for (const event of buffered.splice(0, buffered.length)) deliver(event);
    },
    /** The connection went: events wait, and a session whose phone cannot reach it for ten minutes ends (§7.2). */
    detached: () => {
      send = undefined;
      if (session && !away) away = setTimeout(() => { away = undefined; endSession("away"); }, REMOTE_AWAY_MS);
    },
    /** 「断开遥控」 on this computer, a level change, the program closing. */
    stopAll: (reason: string) => endSession(reason),
    status
  };
}
export type RemoteControl = ReturnType<typeof createRemoteControl>;

/** Whether a stored level says remote control is on (the old boolean `shell: true` reads as 「无人值守」). */
export function levelOf(value: { level?: unknown; shell?: unknown } | undefined): RemoteLevel {
  if (value?.level === "remote" || value?.level === "unattended" || value?.level === "off") return value.level;
  return value?.shell === true ? "unattended" : "off";
}

export const remoteExists = (dir: string) => existsSync(remoteFile(dir));
