import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { RECORDING_FILE, RECORDING_INBOX_SEGMENTS, audioKind, RECORDING_SERVER_CONSENT, RECORDING_SILENT_EVENT, RECORDING_TRANSCRIBED_EVENT,
  RECORDING_UPLOAD_DAILY_LIMIT, RECORDING_UPLOAD_LIMIT } from "@crossline/core";
import { readLocale } from "@crossline/db";
import { tFor } from "../../../../lib/i18n";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { workspaceForDeviceToken } from "../../../../lib/energy";
import { dataDirectory, getStore } from "../../../../lib/crossline";

const DAILY_SETTING = "recordings.upload.bytes";
const EXTENSION: Record<string, string> = { "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/m4a": "m4a", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav",
  "audio/aac": "aac", "audio/ogg": "ogg", "audio/opus": "opus", "audio/webm": "webm", "audio/flac": "flac" };

/**
 * A recording from the phone's shortcut (docs/phone-recording.md 「服务器转写」): the raw file as the body, the recording-scoped device
 * token as `Authorization: Bearer <token>`, and its name as `?name=`. It is written to the inbox as it arrives — never held in memory —
 * and waits there for the transcriber container's night. Refused unless the person turned on 录音在服务器转写; one file is at most
 * 300 MB and a workspace's uploads at most 3 GB a day. A health or capture token cannot upload. The same audio uploaded again — already
 * transcribed, found silent, or still waiting — is recognised by its sha256 as it arrives, not kept, not counted against the day, and
 * answered `{ok: true, duplicate: true}`.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const token = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(request.headers.get("authorization") ?? "")?.[1];
  const workspaceId = token ? workspaceForDeviceToken(token, "recording") : undefined;
  if (!workspaceId) return Response.json({ ok: false, code: "RECORDING_TOKEN_INVALID" }, { status: 401 });
  const store = getStore();
  // A shortcut has no page: its answers are in the account's language.
  const t = tFor(readLocale(store, workspaceId));
  if (store.getSetting(workspaceId, RECORDING_SERVER_CONSENT) !== "granted") return Response.json({ ok: false, code: "RECORDING_SERVER_NOT_ENABLED",
    message: t("设置里还没有打开「录音在服务器转写」。") }, { status: 403 });

  const named = path.basename((new URL(request.url).searchParams.get("name") ?? "").replace(/\\/g, "/")).replace(/[\u0000-\u001f]/g, "").trim().slice(-120);
  const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > RECORDING_UPLOAD_LIMIT) return Response.json({ ok: false, code: "RECORDING_TOO_LARGE", message: t("单个录音不能超过 300 MB。") }, { status: 413 });
  const day = new Date().toISOString().slice(0, 10);
  let used = { day, bytes: 0 };
  try { const stored = JSON.parse(store.getSetting(workspaceId, DAILY_SETTING) ?? "null") as typeof used | null; if (stored?.day === day) used = stored; } catch { /* starts afresh */ }
  if (used.bytes + declared > RECORDING_UPLOAD_DAILY_LIMIT) return Response.json({ ok: false, code: "RECORDING_DAILY_LIMIT", message: t("今天上传的录音已到 3 GB。") }, { status: 429 });
  if (!request.body) return Response.json({ ok: false, code: "RECORDING_EMPTY" }, { status: 400 });

  // The opening bytes decide first: a Voice Memos recording handed over by the Find Recordings action comes with a name and a type
  // that say nothing useful (every upload was refused as 415 on 2026-10-21), while its content is plainly m4a.
  const reader = request.body.getReader();
  const head: Uint8Array[] = [];
  let headSize = 0;
  while (headSize < 16) {
    const next = await reader.read();
    if (next.done) break;
    head.push(next.value); headSize += next.value.byteLength;
  }
  const opening = Buffer.concat(head);
  // Voice Memos names a recording 「新录音 3」, with no extension, and a shortcut may send it as application/octet-stream. ffmpeg reads
  // the format from the content, not the name, so a recording that says nothing about its type is taken as Voice Memos' m4a; only a name
  // or type that says it is something else (a document, a picture) is refused.
  const otherExtension = /\.[A-Za-z][A-Za-z0-9]{0,4}$/.test(named) && !RECORDING_FILE.test(named);
  const otherType = Boolean(type) && !type.startsWith("audio/") && type !== "application/octet-stream" && !(type === "video/mp4" || type === "video/webm");
  const extension = audioKind(opening) ?? RECORDING_FILE.exec(named)?.[1]?.toLowerCase() ?? EXTENSION[type] ?? (otherExtension || otherType ? undefined : "m4a");
  if (!extension) {
    await reader.cancel().catch(() => undefined);
    const looksText = opening.length > 0 && [...opening.subarray(0, 16)].every((byte) => byte >= 0x09 && byte < 0x7f || byte >= 0x80);
    return Response.json({ ok: false, code: "RECORDING_TYPE_UNSUPPORTED", message: looksText
      ? t("只收录音（m4a、mp3、wav、aac、opus、ogg、webm、flac）。收到的类型：{{type}}，内容是文字：「{{text}}」", { type: type || t("无"), text: opening.toString("utf8").slice(0, 40) })
      : t("只收录音（m4a、mp3、wav、aac、opus、ogg、webm、flac）。收到的类型：{{type}}", { type: type || t("无") }) }, { status: 415 });
  }
  const given = named && !RECORDING_FILE.test(named) ? `${named}.${extension}` : named;

  const dir = path.join(dataDirectory(), ...RECORDING_INBOX_SEGMENTS, workspaceId);
  await mkdir(dir, { recursive: true });
  const final = path.join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`);
  const part = `${final}.part`;
  const out = createWriteStream(part);
  let size = 0;
  const hash = createHash("sha256");
  try {
    const chunks = async function* () { yield* head; for (;;) { const next = await reader.read(); if (next.done) return; yield next.value; } };
    for await (const chunk of chunks()) {
      size += chunk.byteLength;
      if (size > RECORDING_UPLOAD_LIMIT || used.bytes + size > RECORDING_UPLOAD_DAILY_LIMIT) throw new Error("RECORDING_TOO_LARGE");
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve));
    }
    await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => error ? reject(error) : resolve()));
  } catch (error) {
    out.destroy();
    await rm(part, { force: true });
    const tooLarge = error instanceof Error && error.message === "RECORDING_TOO_LARGE";
    return Response.json({ ok: false, code: tooLarge ? "RECORDING_TOO_LARGE" : "RECORDING_UPLOAD_FAILED" }, { status: tooLarge ? 413 : 400 });
  }
  if (!size) { await rm(part, { force: true }); return Response.json({ ok: false, code: "RECORDING_EMPTY" }, { status: 400 }); }
  const sha256 = hash.digest("hex");
  const waiting = await Promise.all((await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith(".json"))
    .map((name) => readFile(path.join(dir, name), "utf8").then((text) => (JSON.parse(text) as { sha256?: unknown }).sha256).catch(() => undefined)));
  if (waiting.includes(sha256) || store.listEvents(workspaceId, { type: [RECORDING_TRANSCRIBED_EVENT, RECORDING_SILENT_EVENT], entityId: sha256 }).length) {
    await rm(part, { force: true });
    return Response.json({ ok: true, duplicate: true, size, message: t("这段录音已经收到过，不会再转一次。") });
  }
  await writeFile(`${final}.json`, JSON.stringify({ name: given || t("录音.{{extension}}", { extension }), size, sha256 }));
  await rename(part, final);
  store.setSetting(workspaceId, DAILY_SETTING, JSON.stringify({ day, bytes: used.bytes + size }));
  return Response.json({ ok: true, size });
}
