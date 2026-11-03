import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DICTATION_MAX_BYTES, DICTATION_SAMPLE_RATE } from "@crossline/core";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { dataDirectory } from "../../../../lib/crossline";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { serviceProxy } from "../../../../lib/service-proxy";

/**
 * One dictation for Crossline's own engine (docs/voice-input.md): the page sends 16 kHz mono 16-bit PCM it decoded itself, never the file
 * the browser recorded, so nothing but samples reaches the server. It is written beside the ledger for the worker, which reads and deletes
 * it at once; a clip left behind is swept within two minutes and never enters a backup.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const refuse = (code: string, status = 400) => Response.json({ ok: false, blocker: { code, message: code } }, { status });
  if (Number(request.headers.get("content-length") ?? 0) > DICTATION_MAX_BYTES) return refuse("VOICE_CLIP_LENGTH", 413);
  const bytes = new Uint8Array(await request.arrayBuffer().catch(() => new ArrayBuffer(0)));
  if (bytes.length > DICTATION_MAX_BYTES || bytes.length < DICTATION_SAMPLE_RATE / 5 || bytes.length % 2) return refuse("VOICE_CLIP_LENGTH");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(access.ctx.workspaceId)) return refuse("VOICE_FILE_INVALID");
  const folder = path.join(dataDirectory(), "dictation", "upload", access.ctx.workspaceId);
  mkdirSync(folder, { recursive: true });
  const stored = `${randomUUID()}.pcm`;
  writeFileSync(path.join(folder, stored), bytes);
  return serviceProxy(access.ctx, "/v1/voice/transcribe", { method: "POST", timeoutMs: 120_000, body: { file: stored } });
}
