import { isLineDomain } from "@crossline/identity-packs";
import { recordFromNotification, RECORD_KINDS, type AccessContext, type DomainRecordInput } from "@crossline/core";
import { resolveAccessContext } from "../../../lib/access-guard";
import { getStore } from "../../../lib/crossline";
import { workspaceForDeviceToken } from "../../../lib/energy";
import { addDomainRecord, domainRecordViews, personToday, removeDomainRecord } from "../../../lib/records";
import { tOf } from "../../../lib/locale";
import { isCrossSiteWrite } from "../../../lib/same-origin";
import { withUndo } from "../../../lib/undo";

const MAX_BYTES = 64_000;
const MAX_PER_HOUR = 120;
const RECENT_SETTING = "records.phone.recent";

/** The domains' numbers and the last thirty records of each, for the line card and the records drawer. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return Response.json({ ok: true, domains: domainRecordViews(access.ctx) });
}

/**
 * Records from a phone or the page (docs/domain-lines.md). A phone sends `Authorization: Bearer <token>` with the `records` token from 设置
 * (no session: a shortcut has none), and that token can do nothing else; the page sends its session. The body is `{records: [...]}` —
 * structured, e.g. Apple Wallet's Transaction automation (`{clientId, domain, kind, value, currency, category, note, at}`) — and/or
 * `{notifications: [{id, app, title, text, at}]}`, payment notifications relayed as they are, which code reads (one amount, a payment word)
 * without any model. Every record is checked and written once per `clientId` / notification id; what was left out is said, with why.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const bearer = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(request.headers.get("authorization") ?? "")?.[1];
  let ctx: AccessContext;
  if (bearer) {
    const workspaceId = workspaceForDeviceToken(bearer, "records");
    const ownerId = workspaceId ? getStore().getWorkspaceOwnerId(workspaceId) : undefined;
    if (!workspaceId || !ownerId) return Response.json({ ok: false, code: "RECORDS_TOKEN_INVALID" }, { status: 401 });
    const now = Date.now();
    let recent: number[] = [];
    try { recent = (JSON.parse(getStore().getSetting(workspaceId, RECENT_SETTING) ?? "[]") as number[]).filter((at) => now - at < 3_600_000); } catch { /* afresh */ }
    if (recent.length >= MAX_PER_HOUR) return Response.json({ ok: false, code: "RECORDS_RATE_LIMITED" }, { status: 429 });
    getStore().setSetting(workspaceId, RECENT_SETTING, JSON.stringify([...recent, now]));
    ctx = { principalId: ownerId, workspaceId, role: "owner", identity: { provider: "credential", issuer: "crossline-device", subject: ownerId },
      authMethod: "device-token", requestId: `records:${now}` };
  } else {
    const access = await resolveAccessContext(request);
    if ("response" in access) return access.response;
    ctx = access.ctx;
  }
  const text = await request.text();
  if (text.length > MAX_BYTES) return Response.json({ ok: false, code: "RECORDS_BODY_TOO_LARGE" }, { status: 413 });
  let body: { records?: unknown; notifications?: unknown };
  try { body = JSON.parse(text) as typeof body; } catch { return Response.json({ ok: false, code: "INVALID_JSON" }, { status: 400 }); }
  const today = personToday(ctx);
  const source = bearer ? "phone" as const : "input" as const;
  const outcome = { stored: 0, duplicates: 0, skipped: [] as Array<{ id: string; reason: string }> };
  const keep = (id: string, input: Omit<DomainRecordInput, "source" | "dedupeKey" | "sourceRef"> & { merchant?: string; app?: string }) => {
    const result = addDomainRecord(ctx, { ...input, source, sourceRef: id, ...(id ? { dedupeKey: `${source}:${id}` } : {}) });
    if (!result.ok) outcome.skipped.push({ id, reason: result.message });
    else if (result.inserted) outcome.stored += 1;
    else outcome.duplicates += 1;
  };
  const str = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";
  for (const item of (Array.isArray(body.records) ? body.records : []).slice(0, 50) as Array<Record<string, unknown>>) {
    const id = str(item?.clientId, 120);
    const domain = item?.domain, kind = item?.kind;
    if (!isLineDomain(domain) || !(RECORD_KINDS[domain] as readonly unknown[]).includes(kind)) { outcome.skipped.push({ id, reason: tOf(ctx)("未知的领域或种类") }); continue; }
    keep(id, { domain, kind: kind as DomainRecordInput["kind"], value: Number(item.value), unit: str(item.unit, 16), currency: domain === "wealth" ? str(item.currency, 8).toUpperCase() || "CNY" : "",
      category: str(item.category, 40) || str(item.merchant, 40), note: str(item.note, 200), at: str(item.at, 40) || today, merchant: str(item.merchant, 60), app: "wallet" });
  }
  for (const item of (Array.isArray(body.notifications) ? body.notifications : []).slice(0, 50) as Array<Record<string, unknown>>) {
    const id = str(item?.id, 120);
    const read = recordFromNotification({ id, app: str(item?.app, 60), title: str(item?.title, 200), text: str(item?.text, 400), at: str(item?.at, 40) }, today);
    if (!read.ok) { outcome.skipped.push({ id, reason: read.reason }); continue; }
    keep(id, { ...read.record, app: str(item?.app, 60) });
  }
  return Response.json({ ok: true, ...outcome });
}

/** `?id=` removes one record (undoable from the page). */
export async function DELETE(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const id = new URL(request.url).searchParams.get("id") ?? "";
  const result = await withUndo(access.ctx, tOf(access.ctx)("删除一条记录"), () => removeDomainRecord(access.ctx, id));
  return Response.json(result, { status: result.ok ? 200 : 404 });
}
