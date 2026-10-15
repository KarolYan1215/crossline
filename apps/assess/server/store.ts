import { createHmac, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TYPE_AXES, type TypeAxisId } from "@crossline/core/assess";
import { PAIRS_SHOWN_MAX, RESULT_RETENTION_DAYS, type Appearance, type AvatarStatus } from "../lib/contract";
import { dataDir } from "./config";
import { db } from "./db";

/**
 * The public test's storage (workstream W2, docs/beta-launch.md §7 P-L1): results, their two tokens, pairs, the avatar state and the
 * 90-day retention, in its own SQLite file under `dataDir()`. Signatures fixed by the contract; W2 owns the bodies.
 *
 * A result past its `expires_at` is treated as gone by every read even before the hourly purge removes it, so no link outlives the
 * retention by up to an hour.
 */

export type StoredResult = {
  id: string;
  /** Opens the person's own result (their email link); never shown to anyone else. */
  resultToken: string;
  /** Opens the invitation and makes a pair; printed on the poster. */
  inviteToken: string;
  email: string;
  nickname: string;
  scores: Record<TypeAxisId, number>;
  code: string;
  appearance: Appearance;
  sendEmail: boolean;
  avatar: { state: AvatarStatus["state"]; file: string };
  createdAt: string;
  expiresAt: string;
};

export type StoredPair = { id: string; pairToken: string; inviterId: string; inviteeId: string; createdAt: string };

type ResultRow = {
  id: string; result_token: string; invite_token: string; email: string; nickname: string; scores_json: string; code: string;
  appearance_json: string; send_email: number; avatar_state: AvatarStatus["state"]; avatar_file: string; created_at: string; expires_at: string;
};
type PairRow = { id: string; pair_token: string; inviter_id: string; invitee_id: string; created_at: string };

/** 128 random bits, URL-safe: the capability in every link (W3C TAG, Good Practices for Capability URLs: at least 120 bits). */
export const newToken = (): string => randomBytes(16).toString("base64url");

const nowIso = () => new Date().toISOString();

const toResult = (row: ResultRow): StoredResult => ({
  id: row.id, resultToken: row.result_token, inviteToken: row.invite_token, email: row.email, nickname: row.nickname,
  scores: JSON.parse(row.scores_json) as Record<TypeAxisId, number>, code: row.code,
  appearance: JSON.parse(row.appearance_json) as Appearance, sendEmail: row.send_email === 1,
  avatar: { state: row.avatar_state, file: row.avatar_file }, createdAt: row.created_at, expiresAt: row.expires_at
});
const toPair = (row: PairRow): StoredPair =>
  ({ id: row.id, pairToken: row.pair_token, inviterId: row.inviter_id, inviteeId: row.invitee_id, createdAt: row.created_at });

const liveResult = (column: "result_token" | "invite_token" | "id", value: string): StoredResult | undefined => {
  if (!value) return undefined;
  const row = db().prepare(`SELECT * FROM results WHERE ${column} = ? AND expires_at > ?`).get(value, nowIso()) as ResultRow | undefined;
  return row ? toResult(row) : undefined;
};

export function getResultByToken(resultToken: string): StoredResult | undefined { return liveResult("result_token", resultToken); }
export function getResultByInvite(inviteToken: string): StoredResult | undefined { return liveResult("invite_token", inviteToken); }
export function getResultById(id: string): StoredResult | undefined { return liveResult("id", id); }

/** A pair whose two results are both still kept. */
export function getPairByToken(pairToken: string): StoredPair | undefined {
  if (!pairToken) return undefined;
  const row = db().prepare(`
    SELECT p.* FROM pairs p JOIN results a ON a.id = p.inviter_id JOIN results b ON b.id = p.invitee_id
    WHERE p.pair_token = @token AND a.expires_at > @now AND b.expires_at > @now`).get({ token: pairToken, now: nowIso() }) as PairRow | undefined;
  return row ? toPair(row) : undefined;
}

let recordedMemo: { at: number; value: Partial<Record<TypeAxisId, number[]>> } | undefined;
const RECORDED_MEMO_MS = 60_000;

/** Every recorded score per axis, for the rank once there are enough (`axisRank`). Read at most once a minute: a rank is not live data. */
export function recordedScores(): Partial<Record<TypeAxisId, number[]>> {
  if (recordedMemo && Date.now() - recordedMemo.at < RECORDED_MEMO_MS) return recordedMemo.value;
  const value: Partial<Record<TypeAxisId, number[]>> = Object.fromEntries(TYPE_AXES.map((axis) => [axis.id, [] as number[]]));
  const rows = db().prepare("SELECT scores_json FROM results WHERE expires_at > ?").all(nowIso()) as Array<{ scores_json: string }>;
  for (const row of rows) {
    const scores = JSON.parse(row.scores_json) as Record<TypeAxisId, number>;
    for (const axis of TYPE_AXES) if (typeof scores[axis.id] === "number") value[axis.id]!.push(scores[axis.id]);
  }
  recordedMemo = { at: Date.now(), value };
  return value;
}

/** The avatar pipeline reports progress here. */
export function setAvatarState(resultId: string, state: AvatarStatus["state"], file?: string): void {
  db().transaction(() => {
    if (file === undefined) db().prepare("UPDATE results SET avatar_state = ? WHERE id = ?").run(state, resultId);
    else db().prepare("UPDATE results SET avatar_state = ?, avatar_file = ? WHERE id = ?").run(state, file, resultId);
    if (state !== "drawing" && state !== "ready") return;
    const row = db().prepare("SELECT email FROM results WHERE id = ?").get(resultId) as { email: string } | undefined;
    if (row) db().prepare("INSERT OR IGNORE INTO avatar_draws (result_id, email_key, created_at) VALUES (?, ?, ?)")
      .run(resultId, emailKey(row.email), new Date().toISOString());
  }).immediate();
}

let secret: { dir: string; key: Buffer } | undefined;

/** This install's own key (`<dataDir>/draw-key`, made on first use): the draw record keeps HMAC(address), never the address. */
function drawKey(): Buffer {
  const dir = dataDir();
  if (secret?.dir === dir) return secret.key;
  const file = path.join(dir, "draw-key");
  let key: Buffer;
  try { key = fs.readFileSync(file); }
  catch {
    fs.mkdirSync(dir, { recursive: true });
    key = randomBytes(32);
    try { fs.writeFileSync(file, key, { flag: "wx", mode: 0o600 }); }
    catch { key = fs.readFileSync(file); }
  }
  secret = { dir, key };
  return key;
}

const emailKey = (email: string): string => createHmac("sha256", drawKey()).update(email.trim().toLowerCase()).digest("base64url");

/**
 * Figures already drawn (or being drawn) for this address within the retention period: every result that reached `drawing` or
 * `ready`, recorded under a keyed hash of the address in `avatar_draws`. A result still `queued` (the one being enqueued right now)
 * or settled on the template does not count, so every address gets its full `AVATARS_PER_EMAIL`; deleting a result does not give one
 * back, so deleting and retaking cannot draw more. The record holds no address and goes after `RESULT_RETENTION_DAYS`.
 */
export function avatarsDrawnFor(email: string): number {
  const since = new Date(Date.now() - RESULT_RETENTION_DAYS * 86_400_000).toISOString();
  const row = db().prepare("SELECT COUNT(*) AS n FROM avatar_draws WHERE email_key = ? AND created_at > ?").get(emailKey(email), since) as { n: number };
  return row.n;
}

export type NewResult = {
  email: string; nickname: string; scores: Record<TypeAxisId, number>; code: string; appearance: Appearance; sendEmail: boolean;
};

/** Stores a result with two fresh tokens and its retention date. The email is kept lowercased. */
export function createResult(input: NewResult, now: Date = new Date()): StoredResult {
  const result: StoredResult = {
    id: randomUUID(), resultToken: newToken(), inviteToken: newToken(), email: input.email.trim().toLowerCase(), nickname: input.nickname,
    scores: input.scores, code: input.code, appearance: input.appearance, sendEmail: input.sendEmail,
    avatar: { state: "queued", file: "" }, createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + RESULT_RETENTION_DAYS * 86_400_000).toISOString()
  };
  db().prepare(`
    INSERT INTO results (id, result_token, invite_token, email, nickname, scores_json, code, appearance_json, send_email, avatar_state,
      avatar_file, created_at, expires_at)
    VALUES (@id, @resultToken, @inviteToken, @email, @nickname, @scores, @code, @appearance, @sendEmail, 'queued', '', @createdAt, @expiresAt)`)
    .run({ ...result, scores: JSON.stringify(result.scores), appearance: JSON.stringify(result.appearance), sendEmail: result.sendEmail ? 1 : 0 });
  recordedMemo = undefined;
  return result;
}

/** The pair already made through this inviter's invitation by this address, if any. */
export function findPair(inviterId: string, inviteeEmail: string): StoredPair | undefined {
  const row = db().prepare(`
    SELECT p.* FROM pairs p JOIN results b ON b.id = p.invitee_id
    WHERE p.inviter_id = ? AND b.email = ? AND b.expires_at > ? ORDER BY p.created_at LIMIT 1`)
    .get(inviterId, inviteeEmail.trim().toLowerCase(), nowIso()) as PairRow | undefined;
  return row ? toPair(row) : undefined;
}

/**
 * Pairs the inviter with the invitee, at most once per inviter and invitee address: when that address already has a pair through this
 * invitation, the existing pair is returned and `created` is false (checked and written in one transaction).
 */
export function createPair(inviterId: string, inviteeId: string, now: Date = new Date()): { pair: StoredPair; created: boolean } {
  return db().transaction(() => {
    const invitee = db().prepare("SELECT email FROM results WHERE id = ?").get(inviteeId) as { email: string } | undefined;
    if (!invitee) throw new Error("PAIR_INVITEE_MISSING");
    const existing = findPair(inviterId, invitee.email);
    if (existing) return { pair: existing, created: false };
    const pair: StoredPair = { id: randomUUID(), pairToken: newToken(), inviterId, inviteeId, createdAt: now.toISOString() };
    db().prepare("INSERT INTO pairs (id, pair_token, inviter_id, invitee_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(pair.id, pair.pairToken, pair.inviterId, pair.inviteeId, pair.createdAt);
    return { pair, created: true };
  }).immediate();
}

/** The pairs one result is part of (either side), newest first, at most `PAIRS_SHOWN_MAX`, both ends still kept. */
export function listPairs(resultId: string): StoredPair[] {
  const rows = db().prepare(`
    SELECT p.* FROM pairs p JOIN results a ON a.id = p.inviter_id JOIN results b ON b.id = p.invitee_id
    WHERE (p.inviter_id = @id OR p.invitee_id = @id) AND a.expires_at > @now AND b.expires_at > @now
    ORDER BY p.created_at DESC LIMIT @limit`).all({ id: resultId, now: nowIso(), limit: PAIRS_SHOWN_MAX }) as PairRow[];
  return rows.map(toPair);
}

/** An avatar file to remove, only ever inside the data directory. */
function removeAvatarFile(file: string): void {
  if (!file) return;
  const root = path.resolve(dataDir());
  const target = path.resolve(root, file);
  if (target !== root && !target.startsWith(root + path.sep)) return;
  try { fs.rmSync(target, { force: true }); } catch (error) { console.warn(JSON.stringify({ event: "assess.avatar_remove_failed", error: String(error) })); }
}

/** Removes a result, every pair it is part of (both sides) and its drawn figure. Returns whether there was anything to remove. */
export function deleteResult(id: string): boolean {
  const removed = db().transaction(() => {
    const row = db().prepare("SELECT avatar_file FROM results WHERE id = ?").get(id) as { avatar_file: string } | undefined;
    if (!row) return undefined;
    db().prepare("DELETE FROM pairs WHERE inviter_id = ? OR invitee_id = ?").run(id, id);
    db().prepare("DELETE FROM results WHERE id = ?").run(id);
    return row;
  }).immediate();
  if (!removed) return false;
  removeAvatarFile(removed.avatar_file);
  recordedMemo = undefined;
  return true;
}

/** Deletes every result past its retention date (with its pairs and figure). Returns how many results went. */
export function purgeExpired(now: Date = new Date()): number {
  const ids = db().prepare("SELECT id FROM results WHERE expires_at <= ?").all(now.toISOString()) as Array<{ id: string }>;
  let removed = 0;
  for (const { id } of ids) if (deleteResult(id)) removed++;
  db().prepare("DELETE FROM avatar_draws WHERE created_at <= ?").run(new Date(now.getTime() - RESULT_RETENTION_DAYS * 86_400_000).toISOString());
  return removed;
}
