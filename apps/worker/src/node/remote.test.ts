import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { webcrypto } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { confinedTo } from "@crossline/core/agent-guard";
import { newEnvelope, signEnvelope, toBase64, type RemoteEnvelope, type RemoteKind } from "@crossline/core/remote-control";
import type { AppServerLines } from "./agent";
import { appendAudit, createRemoteControl, levelOf, readAudit, reconcileAudit, remoteLocalAction, verifyAudit, auditFile, type RemoteEvent } from "./remote";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempDir = () => { const dir = mkdtempSync(path.join(tmpdir(), "remote-")); dirs.push(dir); return dir; };
const COMPUTER = "PC-A";
const windows = process.platform === "win32";

type Phone = { id: string; privateKey: CryptoKey; publicKey: string };
async function newPhone(): Promise<Omit<Phone, "id">> {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { privateKey: pair.privateKey as CryptoKey, publicKey: toBase64(new Uint8Array(await webcrypto.subtle.exportKey("spki", pair.publicKey))) };
}

/** A runtime that answers the session's start, records what it is sent, and asks for approvals when told to. */
function fakeRuntime() {
  let onLine: (line: string) => void = () => {};
  const sent: Array<Record<string, unknown>> = [];
  const answers = new Map<string, (result: unknown) => void>();
  const lines: AppServerLines = {
    write: (line) => {
      const message = JSON.parse(line) as { id?: string; method?: string; result?: unknown };
      sent.push(message);
      if (message.method === "initialize") setTimeout(() => onLine(JSON.stringify({ id: message.id, result: { userAgent: "crossline/0.163.0" } })), 0);
      if (message.method === "thread/start") setTimeout(() => onLine(JSON.stringify({ id: message.id, result: { approvalPolicy: "untrusted", thread: { id: "thread-1" } } })), 0);
      if (message.method === "turn/start") setTimeout(() => {
        onLine(JSON.stringify({ id: message.id, result: { turn: { id: "turn-1" } } }));
        onLine(JSON.stringify({ method: "turn/started", params: { turn: { id: "turn-1" } } }));
      }, 0);
      if (message.method === "turn/interrupt") setTimeout(() => onLine(JSON.stringify({ id: message.id, result: {} })), 0);
      if (message.id && message.result !== undefined) answers.get(String(message.id))?.(message.result);
    },
    onLine: (handler) => { onLine = handler; },
    onExit: () => {},
    stop: () => {}
  };
  return {
    lines, sent,
    /** The runtime asks for a command's approval; resolves with what it is answered. */
    ask: (command: string, itemId = "item-1") => new Promise<{ decision?: string }>((resolve) => {
      const id = `approval-${itemId}`;
      answers.set(id, (result) => resolve(result as { decision?: string }));
      onLine(JSON.stringify({ id, method: "item/commandExecution/requestApproval", params: { itemId, threadId: "thread-1", command, cwd: "x" } }));
    })
  };
}

async function setUp(options: { level?: "off" | "remote" | "unattended"; run?: Parameters<typeof createRemoteControl>[0]["run"] } = {}) {
  const dir = tempDir();
  const tasksRoot = path.join(dir, "tasks");
  const home = windows ? "C:\\Users\\person" : "/home/person";
  const runtime = fakeRuntime();
  const events: RemoteEvent[] = [];
  const control = createRemoteControl({ dir, computer: COMPUTER, level: options.level ?? "remote", tasksRoot, home, spawn: () => runtime.lines,
    ...(options.run ? { run: options.run } : {}) });
  control.attached((event) => events.push(event));
  // Pairing: started on this computer, answered by the phone through the site, confirmed here.
  const keys = await newPhone();
  const started = remoteLocalAction(dir, { pair: "start" });
  if (!started.ok) throw new Error("pair");
  const offered = await control.handle({ op: "pair", code: started.store.pairing!.code, publicKey: keys.publicKey, label: "Phone" }) as { ok: boolean; id: string; groups: string };
  const confirmed = remoteLocalAction(dir, { confirm: offered.id });
  const phone: Phone = { id: offered.id, ...keys };
  const sign = (kind: RemoteKind, payload: Record<string, unknown>, extra: { session?: string; computer?: string; envelope?: Partial<RemoteEnvelope>; signer?: Phone } = {}) => {
    const envelope = { ...newEnvelope({ kind, computer: extra.computer ?? COMPUTER, ...(extra.session ? { session: extra.session } : {}), payload }), ...(extra.envelope ?? {}) };
    const signer = extra.signer ?? phone;
    return signEnvelope(signer.privateKey, signer.id, envelope);
  };
  const send = async (kind: RemoteKind, payload: Record<string, unknown>, extra: Parameters<typeof sign>[2] = {}) => control.handle({ op: "signed", signed: await sign(kind, payload, extra) });
  return { dir, tasksRoot, home, runtime, events, control, phone, offered, confirmed, sign, send };
}

const until = async <T>(read: () => T | undefined, ms = 3_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) { const value = read(); if (value !== undefined && value !== false) return value; if (Date.now() > end) throw new Error("timeout"); await new Promise((resolve) => setTimeout(resolve, 10)); }
};

test("pairing: a code from this computer, the phone's key, then the person's confirmation here; the fingerprint is six groups of four digits", async () => {
  const { offered, confirmed, dir } = await setUp();
  expect(offered.ok).toBe(true);
  expect(offered.groups).toMatch(/^\d{4}( \d{4}){5}$/);
  expect(confirmed.ok && confirmed.store.phones.map((phone) => phone.id)).toEqual([offered.id]);
  // A wrong code five times voids the pairing.
  const again = remoteLocalAction(dir, { pair: "start" });
  const control = createRemoteControl({ dir, computer: COMPUTER, level: "remote", tasksRoot: dir, home: dir, spawn: () => fakeRuntime().lines });
  const { publicKey } = await newPhone();
  for (let index = 0; index < 5; index += 1) expect(await control.handle({ op: "pair", code: "00000000", publicKey, label: "x" })).toMatchObject({ ok: false, code: "REMOTE_PAIRING_REFUSED" });
  expect(await control.handle({ op: "pair", code: again.ok ? again.store.pairing!.code : "", publicKey, label: "x" })).toMatchObject({ ok: false, code: "REMOTE_PAIRING_REFUSED" });
});

test("every bad instruction is refused with its code and written to the computer's log: unsigned, wrong key, expired, replayed, another computer, a removed phone", async () => {
  const { control, sign, send, dir, phone } = await setUp();
  expect(await control.handle({ op: "signed", signed: { key: phone.id, body: "{}", sig: "" } })).toMatchObject({ code: "REMOTE_SIGNATURE_INVALID" });
  const stranger = { id: phone.id, ...(await newPhone()) };
  expect(await send("session.start", {}, { session: "abcdef1", signer: stranger })).toMatchObject({ code: "REMOTE_SIGNATURE_INVALID" });
  const tampered = await sign("session.start", {}, { session: "abcdef1" });
  expect(await control.handle({ op: "signed", signed: { ...tampered, body: tampered.body.replace("abcdef1", "abcdef2") } })).toMatchObject({ code: "REMOTE_SIGNATURE_INVALID" });
  const old = new Date(Date.now() - 10 * 60_000);
  expect(await send("session.start", {}, { session: "abcdef1", envelope: { issuedAt: old.toISOString(), expiresAt: new Date(old.getTime() + 5 * 60_000).toISOString() } })).toMatchObject({ code: "REMOTE_SIGNATURE_EXPIRED" });
  expect(await send("session.start", {}, { session: "abcdef1", computer: "PC-B" })).toMatchObject({ code: "REMOTE_WRONG_COMPUTER" });
  const once = await sign("session.stop", {}, { session: "none-session" });
  expect(await control.handle({ op: "signed", signed: once })).toMatchObject({ code: "REMOTE_SESSION_CLOSED" });
  expect(await control.handle({ op: "signed", signed: once })).toMatchObject({ code: "REMOTE_REPLAYED" });
  remoteLocalAction(dir, { remove: phone.id });
  expect(await send("session.start", {}, { session: "abcdef1" })).toMatchObject({ code: "REMOTE_SIGNATURE_INVALID" });
  const codes = readAudit(dir, 100).filter((entry) => !entry.ok).map((entry) => entry.code);
  for (const code of ["REMOTE_SIGNATURE_INVALID", "REMOTE_SIGNATURE_EXPIRED", "REMOTE_WRONG_COMPUTER", "REMOTE_REPLAYED"]) expect(codes).toContain(code);
});

test("levels: 「关」 refuses everything; an old `shell: true` reads as 「无人值守」", async () => {
  const { send } = await setUp({ level: "off" });
  expect(await send("session.start", {}, { session: "abcdef1" })).toMatchObject({ ok: false, code: "REMOTE_DISABLED" });
  expect(levelOf({ enabled: true, shell: true } as never)).toBe("unattended");
  expect(levelOf({ shell: false })).toBe("off");
  expect(levelOf({ level: "remote", shell: true })).toBe("remote");
});

test("a session: started by signature in its own folder; one at a time; a folder not on the computer's list is refused", async () => {
  const { send, tasksRoot, events } = await setUp();
  expect(await send("session.start", { folder: path.join(tasksRoot, "..") }, { session: "abcdef1" })).toMatchObject({ code: "REMOTE_FOLDER_REFUSED" });
  const started = await send("session.start", { approval: "each" }, { session: "abcdef1" });
  expect(started).toMatchObject({ ok: true, folder: path.join(tasksRoot, "remote-abcdef1") });
  expect(events.map((event) => event.type)).toContain("session.started");
  expect(await send("session.start", {}, { session: "abcdef2" })).toMatchObject({ code: "REMOTE_BUSY" });
  expect(await send("session.stop", {}, { session: "abcdef1" })).toMatchObject({ ok: true });
  expect(events.at(-1)).toMatchObject({ type: "session.ended", reason: "person" });
});

test("「每条都问」: the assistant's command waits for the phone; an approval signed for another command is refused; the right one runs it", async () => {
  const { send, runtime, events } = await setUp();
  await send("session.start", { approval: "each" }, { session: "abcdef1" });
  expect(await send("message", { text: "列一下文件" }, { session: "abcdef1" })).toMatchObject({ ok: true });
  const answered = runtime.ask("Get-ChildItem");
  const asked = await until(() => events.find((event) => event.type === "approval.asked")) as RemoteEvent & { approval: string; sha: string };
  expect(await send("approve", { approval: asked.approval, sha: "0".repeat(64) }, { session: "abcdef1" })).toMatchObject({ code: "REMOTE_PAYLOAD_MISMATCH" });
  expect(await send("approve", { approval: asked.approval, sha: asked.sha }, { session: "abcdef1" })).toMatchObject({ ok: true });
  expect(await answered).toEqual({ decision: "accept" });
});

test("「会话文件夹内自动」 is decided on the computer: inside the folder runs, a path outside asks, the guard's 「拒」 never reaches the phone", async () => {
  const { send, runtime, events, tasksRoot } = await setUp();
  await send("session.start", { approval: "auto_in_folder" }, { session: "abcdef1" });
  await send("message", { text: "go" }, { session: "abcdef1" });
  expect(await runtime.ask("Get-ChildItem", "a")).toEqual({ decision: "accept" });
  const inside = path.join(tasksRoot, "remote-abcdef1", "notes.txt");
  if (windows) expect(await runtime.ask(`Get-Content ${inside}`, "b")).toEqual({ decision: "accept" });
  const outside = runtime.ask(windows ? "Get-Content C:\\Projects\\other\\a.txt" : "cat /etc/hosts", "c");
  await until(() => events.find((event) => event.type === "approval.asked" && event.approval === "c"));
  expect(await runtime.ask(windows ? "Get-Content C:\\Users\\person\\.ssh\\id_rsa" : "cat /home/person/.ssh/id_rsa", "d")).toEqual({ decision: "decline" });
  expect(events.some((event) => event.type === "approval.asked" && event.approval === "d")).toBe(false);
  expect(events.find((event) => event.type === "approval.refused")).toMatchObject({ rule: "secret.path" });
  await send("interrupt", {}, { session: "abcdef1" });
  expect(await outside).toEqual({ decision: "decline" });
});

test("a direct command: the guard's 「拒」 holds even with a valid signature; 「问」 needs a second signed confirmation; output comes back", async () => {
  const ran: string[] = [];
  const { send } = await setUp({ run: async (command) => { ran.push(command); return { exitCode: 0, output: "hello", truncated: false, timedOut: false }; } });
  await send("session.start", {}, { session: "abcdef1" });
  const secret = windows ? "Get-Content $HOME\\.ssh\\id_rsa" : "cat ~/.ssh/id_rsa";
  expect(await send("command", { text: secret.replace("$HOME", "C:\\Users\\person") }, { session: "abcdef1" })).toMatchObject({ ok: false, code: "REMOTE_GUARD_DENIED:secret.path" });
  expect(await send("command", { text: "Remove-Item -Recurse C:\\Projects\\old" }, { session: "abcdef1" })).toMatchObject({ ok: true, state: "needs_confirm" });
  expect(ran).toEqual([]);
  expect(await send("command", { text: "Remove-Item -Recurse C:\\Projects\\old", confirm: true }, { session: "abcdef1" })).toMatchObject({ ok: true, state: "done", output: "hello" });
  expect(await send("command", { text: "echo hi" }, { session: "abcdef1" })).toMatchObject({ ok: true, exitCode: 0 });
  expect(ran).toEqual(["Remove-Item -Recurse C:\\Projects\\old", "echo hi"]);
});

test("away: events wait while the site is gone and arrive first when it is back", async () => {
  const { control, send, events } = await setUp();
  control.detached();
  await send("session.start", {}, { session: "abcdef1" });
  expect(events.some((event) => event.type === "session.started")).toBe(false);
  const later: RemoteEvent[] = [];
  control.attached((event) => later.push(event));
  expect(later.map((event) => event.type)).toContain("session.started");
  control.stopAll("test");
});

test("the audit log is a hash chain: changing one line is found; 「核对」 lists the site's instructions this computer has no record of", async () => {
  const dir = tempDir();
  for (let index = 0; index < 4; index += 1) appendAudit(dir, { at: new Date().toISOString(), event: "message", ok: true, nonce: `n${index}` });
  expect(verifyAudit(dir)).toEqual({ ok: true, lines: 4 });
  const lines = readFileSync(auditFile(dir), "utf8").split("\n");
  lines[1] = lines[1]!.replace("message", "messagX");
  writeFileSync(auditFile(dir), lines.join("\n"));
  expect(verifyAudit(dir)).toMatchObject({ ok: false, brokenAt: 2 });
  const at = new Date().toISOString();
  expect(reconcileAudit(dir, [{ type: "remote.message", at, nonce: "n0" }, { type: "remote.command", at, nonce: "zzz" }, { type: "remote.files", at }]))
    .toEqual([{ type: "remote.command", at, nonce: "zzz" }]);
});

test("confinedTo: only paths inside the folder, nothing that points elsewhere", () => {
  const root = "C:\\Users\\person\\tasks\\remote-1";
  expect(confinedTo("Get-ChildItem", [root])).toBe(true);
  expect(confinedTo(`Get-Content ${root}\\a.txt`, [root])).toBe(true);
  expect(confinedTo("Get-Content C:\\Users\\person\\b.txt", [root])).toBe(false);
  expect(confinedTo("Get-Content ..\\b.txt", [root])).toBe(false);
  expect(confinedTo("Get-Content $env:USERPROFILE\\b.txt", [root])).toBe(false);
  expect(confinedTo("cd C:\\; dir", [root])).toBe(false);
  expect(confinedTo("cat /etc/hosts", [root])).toBe(false);
  expect(confinedTo("Get-Content \\\\server\\share\\a.txt", [root])).toBe(false);
  expect(confinedTo("curl.exe https://example.com/a/b", [root])).toBe(true);
});
