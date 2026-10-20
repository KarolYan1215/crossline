import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { RECORDING_FILE, RECORDING_INBOX_SEGMENTS, RECORDING_SERVER_CONSENT, RECORDING_UPLOAD_DAILY_LIMIT, RECORDING_UPLOAD_LIMIT } from "@crossline/core";
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
 * 300 MB and a workspace's uploads at most 3 GB a day. A health or capture token cannot upload.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const token = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(request.headers.get("authorization") ?? "")?.[1];
  const workspaceId = token ? workspaceForDeviceToken(token, "recording") : undefined;
  if (!workspaceId) return Response.json({ ok: false, code: "RECORDING_TOKEN_INVALID" }, { status: 401 });
  const store = getStore();
  if (store.getSetting(workspaceId, RECORDING_SERVER_CONSENT) !== "granted") return Response.json({ ok: false, code: "RECORDING_SERVER_NOT_ENABLED",
    message: "设置里还没有打开「录音在服务器转写」。" }, { status: 403 });

  const given = path.basename((new URL(request.url).searchParams.get("name") ?? "").replace(/\\/g, "/")).replace(/[\u0000-\u001f]/g, "").trim().slice(-120);
  const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const extension = RECORDING_FILE.exec(given)?.[1]?.toLowerCase() ?? EXTENSION[type];
  if (!extension) return Response.json({ ok: false, code: "RECORDING_TYPE_UNSUPPORTED", message: "只收 m4a、mp3、wav、aac、opus、ogg、webm、flac 录音。" }, { status: 415 });
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > RECORDING_UPLOAD_LIMIT) return Response.json({ ok: false, code: "RECORDING_TOO_LARGE", message: "单个录音不能超过 300 MB。" }, { status: 413 });
  const day = new Date().toISOString().slice(0, 10);
  let used = { day, bytes: 0 };
  try { const stored = JSON.parse(store.getSetting(workspaceId, DAILY_SETTING) ?? "null") as typeof used | null; if (stored?.day === day) used = stored; } catch { /* starts afresh */ }
  if (used.bytes + declared > RECORDING_UPLOAD_DAILY_LIMIT) return Response.json({ ok: false, code: "RECORDING_DAILY_LIMIT", message: "今天上传的录音已到 3 GB。" }, { status: 429 });
  if (!request.body) return Response.json({ ok: false, code: "RECORDING_EMPTY" }, { status: 400 });

  const dir = path.join(dataDirectory(), ...RECORDING_INBOX_SEGMENTS, workspaceId);
  await mkdir(dir, { recursive: true });
  const final = path.join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`);
  const part = `${final}.part`;
  const out = createWriteStream(part);
  let size = 0;
  try {
    for await (const chunk of request.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > RECORDING_UPLOAD_LIMIT || used.bytes + size > RECORDING_UPLOAD_DAILY_LIMIT) throw new Error("RECORDING_TOO_LARGE");
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
  await writeFile(`${final}.json`, JSON.stringify({ name: given || `录音.${extension}`, size }));
  await rename(part, final);
  store.setSetting(workspaceId, DAILY_SETTING, JSON.stringify({ day, bytes: used.bytes + size }));
  return Response.json({ ok: true, size });
}
