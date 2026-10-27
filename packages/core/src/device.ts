import { ACTIVITY_CATEGORIES, type ActivityHour, type InputRhythmBucket } from "./activity-state";
import type { AgentHistorySummary } from "./agent-history";

/**
 * Device mode (docs/device-mode.md, the owner's decision of 2026-10-22): the hosted site is the one primary ledger, and a local install
 * linked to it is a *device* of that account. The device does only what needs its own machine — screen activity, idle stretches, input
 * rhythm, authorized folders, local recordings, the coding-agent time summary — and sends the results here, in the shapes below. Nothing
 * else of the machine travels: no window title, no app name (only a salted hash used to count switches), no audio.
 */

/** The request header carrying a send's idempotency key; a repeated key is answered `duplicate: true` and applied once. */
export const DEVICE_IDEMPOTENCY_HEADER = "idempotency-key";
/** The hosted setting holding the last keys seen (newest last), so a retry after a lost answer is not applied twice. */
export const DEVICE_SEEN_SETTING = "device.seen";
export const DEVICE_SEEN_KEEP = 500;
/** The hosted setting with the last time a device sent anything, and its label: shown on the 「这台电脑」 card. */
export const DEVICE_LAST_SEEN_SETTING = "device.lastSeen";
/** The hosted setting mapping each document a device sent (by the original file's sha256) to the document id it became here. */
export const DEVICE_DOCUMENTS_SETTING = "device.documents";
/** The hosted setting with the device's folders: label, lines, counts — never the path on that machine. */
export const DEVICE_FOLDERS_SETTING = "device.folders";

/**
 * The compute node (docs/compute-node.md): the hosted switch 「作为算力节点」 ("on" while the site accepts this account's computer as the
 * runtime for its model runs; only the runtime owner may) and the last thing the hosted worker saw of the node (`NodeStatus` JSON).
 */
export const NODE_COMPUTE_SETTING = "node.compute";
export const NODE_STATUS_SETTING = "node.status";
/** The hosted setting holding the sha256 of the `device` token, which the node signs in with too. */
export const DEVICE_TOKEN_SETTING = "device.token.sha256";
/**
 * The standalone compute node (the 「Crossline 节点」 installer, docs/compute-node.md): its own token, made when the person approves its
 * pairing code on the 「这台电脑」 card, so pairing it never replaces a linked device's token; and the computer it was paired with.
 */
export const NODE_TOKEN_SETTING = "node.token.sha256";
export const NODE_PAIRED_SETTING = "node.paired";
/** A pairing code: eight letters and digits a person can read aloud (no 0/O, 1/I/L), shown as XXXX-XXXX; valid ten minutes. */
export const PAIR_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const PAIR_TTL_MS = 10 * 60_000;
export const normalizePairCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Limits on what one send may carry; anything past them is cut, not refused. */
export const DEVICE_LIMITS = { daily: 14, hourly: 28 * 24, gaps: 40, rhythm: 14 * 96, segments: 3000, documents: 20, text: 1_500_000, remove: 500,
  folders: 50, transcripts: 10, silent: 50, bodyBytes: 8_000_000 } as const;

export type DeviceConsents = { activity: boolean; detail: boolean; sleep: boolean; rhythm: boolean; agentHistory: boolean };
export type DeviceDaily = { day: string; activeMinutes: number; idleMinutes: number; windowSwitches: number; sampleCount: number };
/** A stretch of screen activity: when, which category, whether idle — and `app` only as an opaque 8-hex token, for counting switches. */
export type DeviceSegment = { start: string; end: string; category: string; idle: boolean; app: string };
export type DeviceActivityPayload = {
  consents: DeviceConsents;
  daily: DeviceDaily[];
  hourly: ActivityHour[];
  gaps: Array<{ from: string; to: string }>;
  lastActive?: string;
  rhythm: InputRhythmBucket[];
  /** Since the start of the oldest day sent: the hosted record of that span is replaced by these. */
  segmentsSince?: string;
  segments: DeviceSegment[];
  agentHistory?: AgentHistorySummary | null;
};
export type DeviceFolder = { id: string; label: string; lines: string[]; linesBy?: "model" | "person"; files: number; lastScanAt?: string };
export type DeviceDocument = { sha256: string; fileName: string; folderId: string; status: "done" | "failed" | "unsupported" | "pending"; note?: string;
  text: string; createdAt: string };
export type DeviceSourcesPayload = { folders?: DeviceFolder[]; documents?: DeviceDocument[]; remove?: string[] };
export type DeviceTranscript = { audioSha: string; fileName: string; label: string; folderId: string; text: string; seconds: number; speechSeconds: number;
  workMs: number; wallMs: number };
export type DeviceSilent = { audioSha: string; fileName: string; folderId: string; seconds: number; speechSeconds: number; workMs: number };
export type DeviceRecordingsPayload = { transcripts?: DeviceTranscript[]; silent?: DeviceSilent[] };

const SHA = /^[a-f0-9]{64}$/;
const APP_TOKEN = /^[a-f0-9]{8}$/;
const iso = (value: unknown): string | undefined => typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : undefined;
const num = (value: unknown, max: number): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : undefined;
const str = (value: unknown, max: number): string => typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, max) : "";
const list = (value: unknown, max: number): unknown[] => Array.isArray(value) ? value.slice(-max) : [];
const obj = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

/**
 * What the hosted side keeps of an activity send: only the known fields, each range-checked; anything else — a `title`, an app's name, a
 * field nobody defined — is dropped here, so no route can store it by accident.
 */
export function cleanActivityPayload(raw: unknown): DeviceActivityPayload {
  const body = obj(raw), consents = obj(body.consents);
  const flag = (value: unknown) => value === true;
  const categories = new Set<string>(ACTIVITY_CATEGORIES);
  const daily = list(body.daily, DEVICE_LIMITS.daily).flatMap((item) => {
    const row = obj(item), day = typeof row.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.day) ? row.day : undefined;
    const active = num(row.activeMinutes, 1440), idle = num(row.idleMinutes, 1440), switches = num(row.windowSwitches, 100_000), samples = num(row.sampleCount, 100_000);
    return day && active !== undefined && idle !== undefined && switches !== undefined && samples !== undefined
      ? [{ day, activeMinutes: active, idleMinutes: idle, windowSwitches: switches, sampleCount: samples }] : [];
  });
  const hourly = list(body.hourly, DEVICE_LIMITS.hourly).flatMap((item) => {
    const row = obj(item), start = iso(row.start), active = num(row.active, 60), idle = num(row.idle, 60);
    return start && active !== undefined && idle !== undefined ? [{ start, active, idle }] : [];
  });
  const gaps = list(body.gaps, DEVICE_LIMITS.gaps).flatMap((item) => {
    const row = obj(item), from = iso(row.from), to = iso(row.to);
    return from && to && Date.parse(to) > Date.parse(from) ? [{ from, to }] : [];
  });
  const rhythm = list(body.rhythm, DEVICE_LIMITS.rhythm).flatMap((item) => {
    const row = obj(item), start = iso(row.start), minutes = num(row.minutes, 15), activeSec = num(row.activeSec, 900), pauses = num(row.pauses, 900), mousePx = num(row.mousePx, 1e9);
    return start && minutes !== undefined && activeSec !== undefined && pauses !== undefined && mousePx !== undefined ? [{ start, minutes, activeSec, pauses, mousePx }] : [];
  });
  const segments = list(body.segments, DEVICE_LIMITS.segments).flatMap((item) => {
    const row = obj(item), start = iso(row.start), end = iso(row.end);
    const category = typeof row.category === "string" && categories.has(row.category) ? row.category : "other";
    const app = typeof row.app === "string" && APP_TOKEN.test(row.app) ? row.app : "";
    return start && end && Date.parse(end) >= Date.parse(start) ? [{ start, end, category, idle: row.idle === true, app }] : [];
  });
  const lastActive = iso(body.lastActive), segmentsSince = iso(body.segmentsSince);
  const history = obj(body.agentHistory);
  const agentHistory = typeof history.updatedAt === "string" && Array.isArray(history.folders) ? history as unknown as AgentHistorySummary : null;
  return { consents: { activity: flag(consents.activity), detail: flag(consents.detail), sleep: flag(consents.sleep), rhythm: flag(consents.rhythm),
    agentHistory: flag(consents.agentHistory) }, daily, hourly, gaps, ...(lastActive ? { lastActive } : {}), rhythm,
    ...(segmentsSince ? { segmentsSince } : {}), segments, agentHistory };
}

export function cleanSourcesPayload(raw: unknown): Required<DeviceSourcesPayload> {
  const body = obj(raw);
  const folders = list(body.folders, DEVICE_LIMITS.folders).flatMap((item): DeviceFolder[] => {
    const row = obj(item), id = str(row.id, 40), label = str(row.label, 120);
    if (!/^[A-Za-z0-9-]{1,40}$/.test(id) || !label) return [];
    const lines = Array.isArray(row.lines) ? row.lines.filter((line): line is string => typeof line === "string" && line.length <= 80).slice(0, 8) : [];
    const lastScanAt = iso(row.lastScanAt);
    const linesBy = row.linesBy === "person" || row.linesBy === "model" ? row.linesBy : undefined;
    return [{ id, label, lines, ...(linesBy ? { linesBy } : {}), files: num(row.files, 1e7) ?? 0,
      ...(lastScanAt ? { lastScanAt } : {}) }];
  });
  const statuses = new Set(["done", "failed", "unsupported", "pending"]);
  const documents = list(body.documents, DEVICE_LIMITS.documents).flatMap((item) => {
    const row = obj(item), sha256 = str(row.sha256, 64), fileName = str(row.fileName, 200).trim();
    if (!SHA.test(sha256) || !fileName) return [];
    const status = typeof row.status === "string" && statuses.has(row.status) ? row.status as DeviceDocument["status"] : "done";
    const note = str(row.note, 400);
    return [{ sha256, fileName, folderId: str(row.folderId, 40), status, ...(note ? { note } : {}), text: str(row.text, DEVICE_LIMITS.text),
      createdAt: iso(row.createdAt) ?? new Date().toISOString() }];
  });
  const remove = list(body.remove, DEVICE_LIMITS.remove).filter((item): item is string => typeof item === "string" && SHA.test(item));
  return { folders, documents, remove };
}

export function cleanRecordingsPayload(raw: unknown): Required<DeviceRecordingsPayload> {
  const body = obj(raw);
  const transcripts = list(body.transcripts, DEVICE_LIMITS.transcripts).flatMap((item) => {
    const row = obj(item), audioSha = str(row.audioSha, 64), fileName = str(row.fileName, 200).trim(), text = str(row.text, DEVICE_LIMITS.text);
    const seconds = num(row.seconds, 86_400), speechSeconds = num(row.speechSeconds, 86_400);
    if (!SHA.test(audioSha) || !fileName || !text.trim() || seconds === undefined || speechSeconds === undefined) return [];
    return [{ audioSha, fileName, label: str(row.label, 120) || "录音", folderId: str(row.folderId, 40), text, seconds, speechSeconds,
      workMs: num(row.workMs, 1e9) ?? 0, wallMs: num(row.wallMs, 1e9) ?? 0 }];
  });
  const silent = list(body.silent, DEVICE_LIMITS.silent).flatMap((item) => {
    const row = obj(item), audioSha = str(row.audioSha, 64), fileName = str(row.fileName, 200).trim();
    if (!SHA.test(audioSha) || !fileName) return [];
    return [{ audioSha, fileName, folderId: str(row.folderId, 40), seconds: num(row.seconds, 86_400) ?? 0, speechSeconds: num(row.speechSeconds, 86_400) ?? 0,
      workMs: num(row.workMs, 1e9) ?? 0 }];
  });
  return { transcripts, silent };
}

/**
 * The primary site's address as the device keeps it: its origin only, over https — or plain http on this machine itself, for tests and a
 * local trial. Anything else (another scheme, credentials in the address, a path someone pasted with the token in it) is refused.
 */
export function primaryOrigin(raw: string): string | undefined {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return undefined; }
  if (url.username || url.password) return undefined;
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return undefined;
  return url.origin;
}
