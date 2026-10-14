import { randomUUID } from "node:crypto";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { workspaceForDeviceToken } from "../../../../lib/energy";
import { addCapturedTaskWithId, getStore } from "../../../../lib/crossline";
import { analyzeNewCapturesInBackground } from "../../../../lib/capture-followups";
import type { AccessContext } from "@crossline/core";

const MAX_PER_HOUR = 30;
const RECENT_SETTING = "capture.shortcut.recent";

/**
 * Siri 「记一下」 (docs/energy-and-ecosystem.md §5): the phone's shortcut dictates a line and posts it here with the capture-scoped token
 * as `Authorization: Bearer <token>`. No session — a shortcut has none — so the token is the authority, and it can only do this: write
 * one line as a capture, which is then analysed like any other. Thirty an hour at most.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const token = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(request.headers.get("authorization") ?? "")?.[1];
  const workspaceId = token ? workspaceForDeviceToken(token, "capture") : undefined;
  if (!workspaceId) return Response.json({ ok: false, code: "CAPTURE_TOKEN_INVALID" }, { status: 401 });
  const store = getStore();
  const ownerId = store.getWorkspaceOwnerId(workspaceId);
  if (!ownerId) return Response.json({ ok: false, code: "CAPTURE_TOKEN_INVALID" }, { status: 401 });
  const body = await request.json().catch(() => ({})) as { text?: unknown };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text || text.length > 240) return Response.json({ ok: false, code: "INVALID_TASK_INPUT" }, { status: 400 });
  const now = Date.now();
  let recent: number[] = [];
  try { recent = (JSON.parse(store.getSetting(workspaceId, RECENT_SETTING) ?? "[]") as number[]).filter((at) => now - at < 3_600_000); } catch { /* starts afresh */ }
  if (recent.length >= MAX_PER_HOUR) return Response.json({ ok: false, code: "CAPTURE_RATE_LIMITED" }, { status: 429 });
  store.setSetting(workspaceId, RECENT_SETTING, JSON.stringify([...recent, now]));
  const ctx: AccessContext = { principalId: ownerId, workspaceId, role: "owner", identity: { provider: "credential", issuer: "crossline-device", subject: ownerId },
    authMethod: "device-token", requestId: `capture-shortcut:${now}` };
  const id = randomUUID();
  addCapturedTaskWithId(ctx, { title: text, context: "" }, id, id);
  analyzeNewCapturesInBackground(ctx);
  return Response.json({ ok: true });
}
