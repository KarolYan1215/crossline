import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { backoffMs, createOutbox, type OutboxItem, type SendResult } from "./outbox";

let dir: string;
let clock: number;
const now = () => new Date(clock);
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "crossline-outbox-")); clock = Date.parse("2026-10-22T10:00:00.000Z"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const recorder = (answers: Array<SendResult | Error>) => {
  const sent: string[] = [];
  return { sent, send: async (item: OutboxItem) => { sent.push(item.id); const next = answers.shift() ?? { status: 200 }; if (next instanceof Error) throw next; return next; } };
};

test("an item is written before it is sent, kept across a restart while the site is unreachable, and sent once it answers", async () => {
  const offline = recorder([new Error("ECONNREFUSED")]);
  const first = createOutbox(dir, { send: offline.send, now });
  expect(first.enqueue({ id: "sources:abc12345", route: "/api/device/sources", body: { documents: [] } })).toBe(true);
  // The same key twice is one item.
  expect(first.enqueue({ id: "sources:abc12345", route: "/api/device/sources", body: { documents: [] } })).toBe(false);
  const stats = await first.flush();
  expect(stats).toMatchObject({ pending: 1, lastError: "ECONNREFUSED" });
  expect(Date.parse(stats.nextAt!) - clock).toBe(backoffMs(1));

  // A new process (the worker restarted) finds the item; before its wait is over nothing is sent.
  const online = recorder([]);
  const second = createOutbox(dir, { send: online.send, now });
  await second.flush();
  expect(online.sent).toEqual([]);
  clock += backoffMs(1);
  expect(await second.flush()).toMatchObject({ pending: 0 });
  expect(online.sent).toEqual(["sources:abc12345"]);
});

test("a newer activity snapshot replaces the unsent one; the backoff grows and stops at an hour", async () => {
  const outbox = createOutbox(dir, { send: recorder([]).send, now });
  outbox.enqueue({ id: "activity:one", route: "/api/device/activity", body: { n: 1 }, supersedes: "activity" });
  outbox.enqueue({ id: "activity:two", route: "/api/device/activity", body: { n: 2 }, supersedes: "activity" });
  outbox.enqueue({ id: "sources:x", route: "/api/device/sources", body: {} });
  expect(outbox.stats().pending).toBe(2);
  expect([1, 2, 3, 8, 20].map(backoffMs)).toEqual([30_000, 60_000, 120_000, 3_600_000, 3_600_000]);
});

test("a revoked token stops sending and keeps everything; a permanent refusal goes to dead/ and is never retried", async () => {
  const answers = recorder([{ status: 401, body: { code: "DEVICE_TOKEN_INVALID" } }]);
  const outbox = createOutbox(dir, { send: answers.send, now });
  outbox.enqueue({ id: "activity:a", route: "/api/device/activity", body: {} });
  outbox.enqueue({ id: "sources:b", route: "/api/device/sources", body: {} });
  expect(await outbox.flush()).toMatchObject({ pending: 2, blocked: { code: "DEVICE_TOKEN_INVALID" } });
  expect(answers.sent).toEqual(["activity:a"]);

  outbox.unblock();
  const refused = recorder([{ status: 400 }, { status: 200 }]);
  const again = createOutbox(dir, { send: refused.send, now });
  const stats = await again.flush();
  expect(stats).toMatchObject({ pending: 0, dead: 1 });
  expect(stats.blocked).toBeUndefined();
  expect(readdirSync(path.join(dir, "dead"))).toHaveLength(1);
  // A duplicate answer (409) counts as delivered.
  again.enqueue({ id: "sources:c", route: "/api/device/sources", body: {} });
  const dup = createOutbox(dir, { send: recorder([{ status: 409 }]).send, now });
  expect(await dup.flush()).toMatchObject({ pending: 0 });
});
