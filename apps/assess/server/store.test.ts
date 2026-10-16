import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { PAIRS_SHOWN_MAX, RESULT_RETENTION_DAYS } from "../lib/contract";
import { db } from "./db";
import {
  avatarsDrawnFor, betaRequested, createPair, createResult, deleteResult, getPairByToken, getResultById, getResultByInvite, getResultByToken, listPairs,
  keepOnlyNewest, listBetaRequests, newToken, purgeExpired, requestBeta, testsTakenBy, recordedScores, setAvatarState, type NewResult
} from "./store";
import { appearance, useTempDataDir } from "./testing";

const temp = useTempDataDir();
let dir = "";
beforeEach(() => { dir = temp.dir(); });
afterEach(() => temp.cleanup());

const input = (email = "Bob@Example.com"): NewResult =>
  ({ email, nickname: "阿宝", scores: { scope: 80, basis: 30, output: 20, rhythm: 70 }, code: "GEMA", appearance, sendEmail: true });

test("a result is stored with a lowercased email, two distinct tokens and the retention date, and read back by each key", () => {
  const now = new Date("2026-10-14T08:00:00Z");
  const result = createResult(input(), new Date());
  expect(result.email).toBe("bob@example.com");
  expect(result.resultToken).not.toBe(result.inviteToken);
  expect(getResultByToken(result.resultToken)).toEqual(result);
  expect(getResultByInvite(result.inviteToken)?.id).toBe(result.id);
  expect(getResultById(result.id)?.appearance).toEqual(appearance);
  expect(getResultByToken(result.inviteToken)).toBeUndefined();
  expect(getResultByInvite(result.resultToken)).toBeUndefined();
  const dated = createResult(input("c@example.com"), now);
  expect(new Date(dated.expiresAt).getTime() - now.getTime()).toBe(RESULT_RETENTION_DAYS * 86_400_000);
});

test("the schema is migrated once, inside the user_version gate, with WAL on", () => {
  createResult(input());
  expect(db().pragma("user_version", { simple: true })).toBe(5);
  expect(db().pragma("journal_mode", { simple: true })).toBe("wal");
  expect(fs.existsSync(path.join(dir, "assess.db"))).toBe(true);
  expect(db().prepare("SELECT name FROM pragma_table_info('results')").all().map((row) => (row as { name: string }).name))
    .not.toContain("answers_json");
});

test("tokens carry 128 random bits, URL-safe, and never repeat", () => {
  const tokens = Array.from({ length: 2000 }, newToken);
  expect(new Set(tokens).size).toBe(tokens.length);
  for (const token of tokens.slice(0, 50)) {
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(16);
  }
});

test("one pair per inviter and invitee address; the pair is listed on both sides", () => {
  const inviter = createResult(input("a@example.com"));
  const first = createResult(input("b@example.com"));
  const again = createResult(input("B@example.com"));
  const made = createPair(inviter.id, first.id);
  expect(made.created).toBe(true);
  const repeat = createPair(inviter.id, again.id);
  expect(repeat).toEqual({ pair: made.pair, created: false });
  expect(getPairByToken(made.pair.pairToken)).toEqual(made.pair);
  expect(listPairs(inviter.id).map((pair) => pair.id)).toEqual([made.pair.id]);
  expect(listPairs(first.id).map((pair) => pair.id)).toEqual([made.pair.id]);
});

test("at most PAIRS_SHOWN_MAX pairs are listed, newest first", () => {
  const inviter = createResult(input("a@example.com"));
  const start = Date.parse("2026-10-14T00:00:00Z");
  for (let index = 0; index < PAIRS_SHOWN_MAX + 3; index++) {
    createPair(inviter.id, createResult(input(`friend${index}@example.com`)).id, new Date(start + index * 60_000));
  }
  const listed = listPairs(inviter.id);
  expect(listed).toHaveLength(PAIRS_SHOWN_MAX);
  expect(listed[0]!.createdAt > listed[1]!.createdAt).toBe(true);
});

test("deleting a result removes its pairs on both sides and its figure, and nothing else", () => {
  const inviter = createResult(input("a@example.com"));
  const invitee = createResult(input("b@example.com"));
  const bystander = createResult(input("c@example.com"));
  const { pair } = createPair(inviter.id, invitee.id);
  const kept = createPair(bystander.id, invitee.id).pair;
  fs.mkdirSync(path.join(dir, "avatars"), { recursive: true });
  fs.writeFileSync(path.join(dir, "avatars", "a.png"), "png");
  setAvatarState(inviter.id, "ready", "avatars/a.png");

  expect(deleteResult(inviter.id)).toBe(true);
  expect(getResultById(inviter.id)).toBeUndefined();
  expect(getPairByToken(pair.pairToken)).toBeUndefined();
  expect(fs.existsSync(path.join(dir, "avatars", "a.png"))).toBe(false);
  expect(getPairByToken(kept.pairToken)).toBeDefined();
  expect(listPairs(invitee.id).map((each) => each.id)).toEqual([kept.id]);
  expect(deleteResult(inviter.id)).toBe(false);

  expect(deleteResult(invitee.id)).toBe(true);
  expect(getPairByToken(kept.pairToken)).toBeUndefined();
  expect(getResultById(bystander.id)).toBeDefined();
});

test("an avatar path outside the data directory is never removed", () => {
  const outside = path.join(path.dirname(dir), `outside-${newToken()}.png`);
  fs.writeFileSync(outside, "png");
  const result = createResult(input());
  setAvatarState(result.id, "ready", outside);
  deleteResult(result.id);
  expect(fs.existsSync(outside)).toBe(true);
  fs.rmSync(outside);
});

test("an expired result is invisible at once and purged with its pairs", () => {
  const old = createResult(input("a@example.com"), new Date(Date.now() - (RESULT_RETENTION_DAYS + 1) * 86_400_000));
  const fresh = createResult(input("b@example.com"));
  const { pair } = createPair(fresh.id, old.id);
  expect(getResultByToken(old.resultToken)).toBeUndefined();
  expect(getResultByInvite(old.inviteToken)).toBeUndefined();
  expect(getPairByToken(pair.pairToken)).toBeUndefined();
  expect(listPairs(fresh.id)).toEqual([]);
  expect(purgeExpired()).toBe(1);
  expect(db().prepare("SELECT COUNT(*) AS n FROM pairs").get()).toEqual({ n: 0 });
  expect(getResultByToken(fresh.resultToken)).toBeDefined();
  expect(purgeExpired()).toBe(0);
});

test("recorded scores collect every kept result per axis; avatars are counted per address", () => {
  createResult(input("a@example.com"));
  const second = createResult({ ...input("a@example.com"), scores: { scope: 10, basis: 90, output: 55, rhythm: 40 } });
  expect(recordedScores().scope?.sort()).toEqual([10, 80]);
  expect(avatarsDrawnFor("A@example.com")).toBe(0);
  setAvatarState(second.id, "template");
  expect(avatarsDrawnFor("a@example.com")).toBe(0);
  setAvatarState(second.id, "drawing");
  expect(avatarsDrawnFor("a@example.com")).toBe(1);
  setAvatarState(second.id, "ready", "avatars/x.png");
  expect(getResultById(second.id)?.avatar).toEqual({ state: "ready", file: "avatars/x.png" });
  expect(avatarsDrawnFor("a@example.com")).toBe(1);
  deleteResult(second.id);
  expect(avatarsDrawnFor("a@example.com")).toBe(1);
  expect(JSON.stringify(db().prepare("SELECT * FROM avatar_draws").all())).not.toContain("example.com");
  expect(purgeExpired(new Date(Date.now() + 91 * 86_400_000))).toBe(1);
  expect(avatarsDrawnFor("a@example.com")).toBe(0);
});

test("a beta request is kept once, listed with the result's address, and goes with the result", () => {
  const result = createResult(input("beta@example.com"));
  expect(betaRequested(result.id)).toBe(false);
  requestBeta(result.id, new Date("2026-10-15T08:00:00Z"));
  requestBeta(result.id, new Date("2026-10-16T08:00:00Z"));
  expect(betaRequested(result.id)).toBe(true);
  expect(listBetaRequests()).toEqual([{ email: "beta@example.com", nickname: result.nickname, code: result.code, requestedAt: "2026-10-15T08:00:00.000Z" }]);
  deleteResult(result.id);
  expect(listBetaRequests()).toEqual([]);
  expect(db().prepare("SELECT COUNT(*) AS n FROM beta_requests").get()).toEqual({ n: 0 });
});

test("only an address's newest result is kept; the count survives deletion and is held under a keyed hash", () => {
  const first = createResult(input("keep@example.com"), new Date(Date.now() - 60_000));
  const friend = createResult(input("pal@example.com"));
  const pair = createPair(first.id, friend.id).pair;
  keepOnlyNewest(first);
  const posters = path.join(dir, "posters");
  fs.mkdirSync(posters, { recursive: true });
  for (const name of [`${first.inviteToken}.type-x.png`, `${pair.pairToken}.pair-y.png`, "someone-else.type-z.png"]) fs.writeFileSync(path.join(posters, name), "png");
  const second = createResult(input("KEEP@example.com"));
  expect(keepOnlyNewest(second)).toBe(1);
  expect(getResultById(first.id)).toBeUndefined();
  expect(getPairByToken(pair.pairToken)).toBeUndefined();
  expect(getResultById(friend.id)).toBeDefined();
  expect(fs.readdirSync(posters)).toEqual(["someone-else.type-z.png"]);
  expect(testsTakenBy("keep@example.com")).toBe(2);
  deleteResult(second.id);
  expect(testsTakenBy("Keep@Example.com")).toBe(2);
  expect(JSON.stringify(db().prepare("SELECT * FROM email_tests").all())).not.toContain("example.com");
});
