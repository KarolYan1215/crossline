import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mirrorSnapshot } from "@crossline/db";
import { getStore } from "../../../../lib/crossline";
import { deviceAccess } from "../../../../lib/device";

/** When each workspace last got a whole body: at most one a minute (a 304 costs nothing to send). */
const lastBody = new Map<string, number>();

/**
 * The device mirror (docs/device-mode.md): a linked computer fetches its account's ledger, one way, server to device. `device` token
 * only; the machine's own settings, token hashes and identity tables are left out (`mirrorSnapshot`). The ETag is a hash of the body, so
 * `If-None-Match` answers 304 whenever nothing the device would keep changed — the ledger's change token moves on every write anywhere
 * in the file, this request's own bookkeeping included, and would never match.
 */
export async function GET(request: Request) {
  const access = deviceAccess(request, { needsKey: false });
  if ("response" in access) return access.response;
  const workspaceId = access.ctx.workspaceId;
  const json = JSON.stringify(mirrorSnapshot(getStore(), workspaceId));
  const etag = `"${createHash("sha256").update(json).digest("hex").slice(0, 40)}"`;
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
  const now = Date.now();
  if (now - (lastBody.get(workspaceId) ?? 0) < 60_000) return Response.json({ ok: false, code: "DEVICE_SNAPSHOT_TOO_SOON" }, { status: 429, headers: { "retry-after": "60" } });
  lastBody.set(workspaceId, now);
  return new Response(new Uint8Array(gzipSync(json)), { headers: { "content-type": "application/gzip", etag, "cache-control": "no-store" } });
}
