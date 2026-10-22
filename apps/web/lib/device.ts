import "server-only";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ACTIVITY_HOURLY, ACTIVITY_HOURLY_DAYS, ACTIVITY_LAST_ACTIVE, ACTIVITY_LONG_GAPS, AGENT_HISTORY_CONSENT, AGENT_HISTORY_SUMMARY, DEVICE_DOCUMENTS_SETTING,
  DEVICE_FOLDERS_SETTING, DEVICE_IDEMPOTENCY_HEADER, DEVICE_LIMITS, DEVICE_LAST_SEEN_SETTING, DEVICE_SEEN_KEEP, DEVICE_SEEN_SETTING, INPUT_RHYTHM_BUCKETS, INPUT_RHYTHM_CONSENT,
  RECORDING_SILENT_EVENT, RECORDING_TRANSCRIBED_EVENT, SLEEP_TRACKING_CONSENT,
  type AccessContext, type ActivityHour, type DeviceActivityPayload, type DeviceFolder, type DeviceRecordingsPayload, type DeviceSourcesPayload, type InputRhythmBucket
} from "@crossline/core";
import { ACTIVITY_DETAIL_CONSENT, dataDirectory, getStore, LOCAL_ACTIVITY_CONSENT } from "./crossline";
import { TOKEN_SETTING, workspaceForDeviceToken } from "./energy";

/**
 * The hosted side of device mode (docs/device-mode.md): a linked computer sends what it read on itself, with the `device` token, and it is
 * written here the way the machine's own worker would have written it — so the energy model, the portrait's work history, the interview,
 * filing and the recording digest read it unchanged. Only the shapes `cleanActivityPayload`/`cleanSourcesPayload`/`cleanRecordingsPayload`
 * keep ever reach these functions.
 */
const MAX_PER_HOUR = 600;
const RECENT_SETTING = "device.recent";
const read = <T>(raw: string | null | undefined, fallback: T): T => { try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; } };

export type DeviceAccess = { ctx: AccessContext; key: string } | { response: Response };

/**
 * A device request's context: the `device` token as `Authorization: Bearer`, at most 600 sends an hour, and an idempotency key (the
 * header). A key seen before is answered `duplicate: true` by the caller without applying anything again.
 */
export function deviceAccess(request: Request, options: { needsKey?: boolean } = {}): DeviceAccess {
  const bearer = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(request.headers.get("authorization") ?? "")?.[1];
  const workspaceId = bearer ? workspaceForDeviceToken(bearer, "device") : undefined;
  const store = getStore();
  const ownerId = workspaceId ? store.getWorkspaceOwnerId(workspaceId) : undefined;
  if (!workspaceId || !ownerId) return { response: Response.json({ ok: false, code: "DEVICE_TOKEN_INVALID", message: "设备令牌无效或已撤销。" }, { status: 401 }) };
  const key = (request.headers.get(DEVICE_IDEMPOTENCY_HEADER) ?? "").trim();
  if (options.needsKey !== false && !/^[A-Za-z0-9:._-]{8,160}$/.test(key)) return { response: Response.json({ ok: false, code: "DEVICE_IDEMPOTENCY_KEY_REQUIRED" }, { status: 400 }) };
  const now = Date.now();
  const recent = read<number[]>(store.getSetting(workspaceId, RECENT_SETTING), []).filter((at) => now - at < 3_600_000);
  if (recent.length >= MAX_PER_HOUR) return { response: Response.json({ ok: false, code: "DEVICE_RATE_LIMITED" }, { status: 429, headers: { "retry-after": "300" } }) };
  store.setSetting(workspaceId, RECENT_SETTING, JSON.stringify([...recent, now]));
  const label = (request.headers.get("x-crossline-device") ?? "").replace(/[^\p{L}\p{N} ._-]/gu, "").slice(0, 60);
  store.setSetting(workspaceId, DEVICE_LAST_SEEN_SETTING, JSON.stringify({ at: new Date(now).toISOString(), ...(label ? { label } : {}) }));
  return { key, ctx: { principalId: ownerId, workspaceId, role: "owner", identity: { provider: "credential", issuer: "crossline-device", subject: ownerId },
    authMethod: "device-token", requestId: `device:${now}` } };
}

/** Whether this send's key was applied already. */
export function seenBefore(workspaceId: string, key: string): boolean {
  return read<string[]>(getStore().getSetting(workspaceId, DEVICE_SEEN_SETTING), []).includes(key);
}
/** Records a key once its send has been applied, the last `DEVICE_SEEN_KEEP` kept. */
export function markSeen(workspaceId: string, key: string): void {
  const seen = read<string[]>(getStore().getSetting(workspaceId, DEVICE_SEEN_SETTING), []).filter((item) => item !== key);
  getStore().setSetting(workspaceId, DEVICE_SEEN_SETTING, JSON.stringify([...seen, key].slice(-DEVICE_SEEN_KEEP)));
}

/**
 * One device send, the same for every kind: the token and key checked, the body read (at most `DEVICE_LIMITS.bodyBytes`) and cleaned to
 * its known shape, a repeated key answered without applying it again, and the key recorded once the send was applied.
 */
export async function handleDeviceSend<T>(request: Request, clean: (raw: unknown) => T, apply: (ctx: AccessContext, payload: T) => Record<string, number>): Promise<Response> {
  const access = deviceAccess(request);
  if ("response" in access) return access.response;
  if (Number(request.headers.get("content-length") ?? "0") > DEVICE_LIMITS.bodyBytes) return Response.json({ ok: false, code: "DEVICE_BODY_TOO_LARGE" }, { status: 413 });
  const text = await request.text();
  if (text.length > DEVICE_LIMITS.bodyBytes) return Response.json({ ok: false, code: "DEVICE_BODY_TOO_LARGE" }, { status: 413 });
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return Response.json({ ok: false, code: "INVALID_JSON" }, { status: 400 }); }
  if (seenBefore(access.ctx.workspaceId, access.key)) return Response.json({ ok: true, duplicate: true });
  const outcome = apply(access.ctx, clean(raw));
  markSeen(access.ctx.workspaceId, access.key);
  return Response.json({ ok: true, ...outcome });
}

/** The 「这台电脑」 card: whether a device token exists, and when a device last sent anything. */
export function deviceStatus(workspaceId: string): { linked: boolean; lastSeen: { at: string; label?: string } | null; folders: DeviceFolder[]; documents: number } {
  const store = getStore();
  return { linked: Boolean(store.getSetting(workspaceId, TOKEN_SETTING.device)),
    lastSeen: read<{ at: string; label?: string } | null>(store.getSetting(workspaceId, DEVICE_LAST_SEEN_SETTING), null),
    folders: read<DeviceFolder[]>(store.getSetting(workspaceId, DEVICE_FOLDERS_SETTING), []),
    documents: Object.keys(read<Record<string, string>>(store.getSetting(workspaceId, DEVICE_DOCUMENTS_SETTING), {})).length };
}

/** 撤销: the token goes, so the device's next send is refused; what it sent stays (it is the person's material). */
export function revokeDeviceToken(workspaceId: string): void {
  const store = getStore();
  store.deleteSetting(workspaceId, TOKEN_SETTING.device);
  store.deleteSetting(workspaceId, DEVICE_LAST_SEEN_SETTING);
}

const set = (workspaceId: string, key: string, value: unknown) => getStore().setSetting(workspaceId, key, JSON.stringify(value));
const drop = (workspaceId: string, key: string) => { if (getStore().getSetting(workspaceId, key) !== undefined) getStore().deleteSetting(workspaceId, key); };

/**
 * Screen activity from the device. Each consent is written as the device holds it, and one that is off deletes what it covered here, as
 * turning it off on the machine does there. Daily rows and hours are merged by day and hour; idle stretches are the device's list; the
 * segments of the span sent replace what was here for it.
 */
export function applyDeviceActivity(ctx: AccessContext, payload: DeviceActivityPayload): { daily: number; hourly: number; gaps: number; rhythm: number; segments: number } {
  const store = getStore(), ws = ctx.workspaceId, { consents } = payload;
  store.setSetting(ws, LOCAL_ACTIVITY_CONSENT, consents.activity ? "granted" : "denied");
  store.setSetting(ws, ACTIVITY_DETAIL_CONSENT, consents.detail ? "granted" : "denied");
  store.setSetting(ws, SLEEP_TRACKING_CONSENT, consents.sleep ? "granted" : "denied");
  store.setSetting(ws, INPUT_RHYTHM_CONSENT, consents.rhythm ? "granted" : "denied");
  store.setSetting(ws, AGENT_HISTORY_CONSENT, consents.agentHistory ? "on" : "off");
  const counted = { daily: 0, hourly: 0, gaps: 0, rhythm: 0, segments: 0 };

  if (consents.activity || consents.detail) {
    for (const row of payload.daily) {
      const { day, ...aggregate } = row;
      store.upsertDailyActivity({ ownerId: ctx.principalId, workspaceId: ws, day, aggregate, observedAt: new Date().toISOString() });
      counted.daily += 1;
    }
    const hours = new Map(read<ActivityHour[]>(store.getSetting(ws, ACTIVITY_HOURLY), []).map((hour) => [hour.start, hour]));
    for (const hour of payload.hourly) hours.set(hour.start, hour);
    const since = new Date(Date.now() - ACTIVITY_HOURLY_DAYS * 86_400_000).toISOString();
    set(ws, ACTIVITY_HOURLY, [...hours.values()].filter((hour) => hour.start >= since).sort((a, b) => a.start.localeCompare(b.start)));
    counted.hourly = payload.hourly.length;
  } else drop(ws, ACTIVITY_HOURLY);

  if (consents.detail && payload.segmentsSince) counted.segments = store.replaceDeviceActivitySegments(ws, payload.segmentsSince, payload.segments);
  else if (!consents.detail) store.deleteActivitySegments(ws);

  if (consents.sleep) {
    set(ws, ACTIVITY_LONG_GAPS, payload.gaps);
    if (payload.lastActive) store.setSetting(ws, ACTIVITY_LAST_ACTIVE, payload.lastActive);
    counted.gaps = payload.gaps.length;
  } else { drop(ws, ACTIVITY_LONG_GAPS); drop(ws, ACTIVITY_LAST_ACTIVE); }

  if (consents.rhythm) {
    const buckets = new Map(read<InputRhythmBucket[]>(store.getSetting(ws, INPUT_RHYTHM_BUCKETS), []).map((bucket) => [bucket.start, bucket]));
    for (const bucket of payload.rhythm) buckets.set(bucket.start, bucket);
    const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
    set(ws, INPUT_RHYTHM_BUCKETS, [...buckets.values()].filter((bucket) => bucket.start >= since).sort((a, b) => a.start.localeCompare(b.start)));
    counted.rhythm = payload.rhythm.length;
  } else drop(ws, INPUT_RHYTHM_BUCKETS);

  if (consents.agentHistory && payload.agentHistory) set(ws, AGENT_HISTORY_SUMMARY, payload.agentHistory);
  else if (!consents.agentHistory) drop(ws, AGENT_HISTORY_SUMMARY);
  return counted;
}

/** Where a device document's text is kept here: the text itself, since the original stays on that computer. */
function writeText(sha256: string, text: string): string {
  const root = path.resolve(dataDirectory(), "sources");
  mkdirSync(root, { recursive: true });
  const target = path.join(root, `${sha256}.device.txt`);
  writeFileSync(target, text, "utf8");
  return pathToFileURL(target).href;
}
/** The name the hosted copy goes by: the original's, with `.txt` after a format the copy is no longer in (a PDF's text is not a PDF). */
const textName = (fileName: string) => /\.(txt|md|markdown|csv|tsv|json|log)$/i.test(fileName) ? fileName : `${fileName}.txt`;

/**
 * Files from the device's authorized folders. Each is kept once, by the original file's sha256 (so the same syllabus uploaded here later
 * is the same document), with its text; a removal deletes only a document a device brought in. The folders' labels and lines are kept
 * for display — never their paths on that machine.
 */
export function applyDeviceSources(ctx: AccessContext, payload: Required<DeviceSourcesPayload>): { saved: number; existing: number; removed: number } {
  const store = getStore(), ws = ctx.workspaceId;
  const known = read<Record<string, string>>(store.getSetting(ws, DEVICE_DOCUMENTS_SETTING), {});
  const folders = new Map(read<DeviceFolder[]>(store.getSetting(ws, DEVICE_FOLDERS_SETTING), []).map((folder) => [folder.id, folder]));
  if (payload.folders.length) set(ws, DEVICE_FOLDERS_SETTING, payload.folders);
  for (const folder of payload.folders) folders.set(folder.id, folder);
  const counted = { saved: 0, existing: 0, removed: 0 };
  for (const doc of payload.documents) {
    const existing = store.listSourceDocuments(ws).find((item) => item.sha256 === doc.sha256);
    // Already here: the device's own earlier send, or the same folder file a whole-ledger copy brought before device mode (same name) —
    // both are the device's to remove later. An upload of the same content under another name stays the person's.
    if (existing) {
      counted.existing += 1;
      if (!known[doc.sha256] && (existing.extractionNote?.startsWith("来自电脑") || existing.fileName === doc.fileName)) known[doc.sha256] = existing.id;
      continue;
    }
    const folder = folders.get(doc.folderId);
    const id = `device-${doc.sha256.slice(0, 24)}`;
    const note = `来自电脑${folder ? `的「${folder.label}」文件夹` : ""}，原文件留在那台电脑上。${doc.note ? ` ${doc.note}` : ""}`.slice(0, 400);
    const saved = store.saveSourceDocument({ id, ownerId: ctx.principalId, workspaceId: ws, kind: "text", fileName: textName(doc.fileName).slice(-200), mediaType: "text/plain",
      sha256: doc.sha256, uri: writeText(doc.sha256, doc.text), extractedText: doc.text, extractionStatus: doc.status === "pending" ? "failed" : doc.status,
      extractionNote: note, createdAt: doc.createdAt });
    known[doc.sha256] = saved.id;
    counted.saved += 1;
  }
  for (const sha of payload.remove) {
    const id = known[sha];
    if (!id) continue;
    delete known[sha];
    const gone = store.deleteSourceDocument(ws, id);
    if (!gone) continue;
    counted.removed += 1;
    if (!gone.uriInUse) { try { rmSync(fileURLToPath(gone.uri), { force: true }); } catch { /* not a local copy */ } }
  }
  set(ws, DEVICE_DOCUMENTS_SETTING, known);
  return counted;
}

/**
 * Transcripts the device made of its own recordings, and those it found silent: each is the same `recording.transcribed` /
 * `recording.silent` event the machine's own worker writes, keyed by the audio's sha256 — so the digest takes it up here, and the same
 * audio sent to the server inbox from the phone is recognised and not transcribed again.
 */
export function applyDeviceRecordings(ctx: AccessContext, payload: Required<DeviceRecordingsPayload>): { transcripts: number; silent: number } {
  const store = getStore(), ws = ctx.workspaceId;
  const counted = { transcripts: 0, silent: 0 };
  for (const item of payload.transcripts) {
    if (store.listEvents(ws, { type: [RECORDING_TRANSCRIBED_EVENT, RECORDING_SILENT_EVENT], entityId: item.audioSha }).length) continue;
    const sha256 = createHash("sha256").update(item.text, "utf8").digest("hex");
    const doc = store.saveSourceDocument({ id: `device-rec-${item.audioSha.slice(0, 20)}`, ownerId: ctx.principalId, workspaceId: ws, kind: "text",
      fileName: `${item.label}/${item.fileName} 转写.txt`.slice(-200), mediaType: "text/plain", sha256, uri: writeText(sha256, item.text), extractedText: item.text,
      extractionStatus: "done", extractionNote: `电脑本机转写：录音 ${Math.max(1, Math.round(item.seconds / 60))} 分钟，有人声约 ${Math.round(item.speechSeconds / 60)} 分钟；录音留在那台电脑上（sha256 ${item.audioSha.slice(0, 12)}）。`,
      createdAt: new Date().toISOString() });
    store.appendEvent({ ownerId: ctx.principalId, workspaceId: ws, idempotencyKey: `${RECORDING_TRANSCRIBED_EVENT}:${item.audioSha}`, type: RECORDING_TRANSCRIBED_EVENT,
      entityId: item.audioSha, payload: { fileName: item.fileName, seconds: item.seconds, speechSeconds: item.speechSeconds, workMs: item.workMs, wallMs: item.wallMs,
        documentId: doc.id, where: "device", folderId: item.folderId } });
    counted.transcripts += 1;
  }
  for (const item of payload.silent) {
    if (store.listEvents(ws, { type: [RECORDING_TRANSCRIBED_EVENT, RECORDING_SILENT_EVENT], entityId: item.audioSha }).length) continue;
    store.appendEvent({ ownerId: ctx.principalId, workspaceId: ws, idempotencyKey: `${RECORDING_SILENT_EVENT}:${item.audioSha}`, type: RECORDING_SILENT_EVENT,
      entityId: item.audioSha, payload: { fileName: item.fileName, seconds: item.seconds, speechSeconds: item.speechSeconds, workMs: item.workMs, where: "device",
        folderId: item.folderId } });
    counted.silent += 1;
  }
  return counted;
}
