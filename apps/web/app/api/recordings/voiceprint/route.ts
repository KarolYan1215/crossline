import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { RECORDING_VOICEPRINT_CONSENT, audioKind } from "@crossline/core";
import { dataDirectory, getStore } from "../../../../lib/crossline";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { voiceprintDir } from "../../../../lib/recordings";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

const LIMIT = 50 * 1024 * 1024;

/**
 * The recording a voiceprint is made from (识别本人声音): the person alone speaking, 15 seconds or more, as the raw file body. It waits
 * beside the voiceprints as `<workspace>.enrol.<ext>` until the transcriber's next pass (within five minutes, night or day), which keeps
 * only the embedding and deletes the audio. A new upload replaces one still waiting. Refused without the consent.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const workspaceId = access.ctx.workspaceId;
  if (getStore().getSetting(workspaceId, RECORDING_VOICEPRINT_CONSENT) !== "granted") return Response.json({ ok: false, code: "VOICEPRINT_NOT_ENABLED",
    message: "先在设置里打开「识别本人声音」。" }, { status: 403 });
  if (Number(request.headers.get("content-length") ?? "0") > LIMIT) return Response.json({ ok: false, code: "VOICEPRINT_TOO_LARGE", message: "录音不能超过 50 MB。" }, { status: 413 });
  if (!request.body) return Response.json({ ok: false, code: "VOICEPRINT_EMPTY" }, { status: 400 });
  const reader = request.body.getReader();
  const head: Uint8Array[] = [];
  let headSize = 0;
  while (headSize < 16) { const next = await reader.read(); if (next.done) break; head.push(next.value); headSize += next.value.byteLength; }
  const extension = audioKind(Buffer.concat(head));
  if (!extension) { await reader.cancel().catch(() => undefined); return Response.json({ ok: false, code: "VOICEPRINT_NOT_AUDIO", message: "这个文件不是录音。" }, { status: 415 }); }
  const dir = voiceprintDir(dataDirectory());
  await mkdir(dir, { recursive: true });
  const final = path.join(dir, `${workspaceId}.enrol.${extension}`);
  const part = `${final}.part`;
  const out = createWriteStream(part);
  let size = 0;
  try {
    const chunks = async function* () { yield* head; for (;;) { const next = await reader.read(); if (next.done) return; yield next.value; } };
    for await (const chunk of chunks()) {
      size += chunk.byteLength;
      if (size > LIMIT) throw new Error("VOICEPRINT_TOO_LARGE");
      if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve));
    }
    await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => error ? reject(error) : resolve()));
  } catch (error) {
    out.destroy();
    await rm(part, { force: true });
    const tooLarge = error instanceof Error && error.message === "VOICEPRINT_TOO_LARGE";
    return Response.json({ ok: false, code: tooLarge ? "VOICEPRINT_TOO_LARGE" : "VOICEPRINT_UPLOAD_FAILED" }, { status: tooLarge ? 413 : 400 });
  }
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (name.startsWith(`${workspaceId}.enrol.`) && !name.endsWith(".part") || name === `${workspaceId}.failed.json`) await rm(path.join(dir, name), { force: true });
  }
  await rename(part, final);
  return Response.json({ ok: true, size });
}
