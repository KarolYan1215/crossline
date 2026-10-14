import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
const { redactedSnapshot, redactCell, snapshotSummary, uploadSnapshot, rememberPreview, takePreview } = await import("./diagnostic-snapshot");

/**
 * The snapshot keeps the ledger's shape and none of its words. Checked two ways: every column of every table the export covers,
 * read from the real schema and filled with a person's kind of text, comes out with none of it; and a ledger written through the
 * store's own methods comes out without its titles, messages, files or raw ids.
 */
const SECRETS = ["给导师的邮件草稿", "final thesis.docx", "https://private.example/x", "Dr. Example Person", "我真正的目标是",
  "Meeting with Alex at 3pm"];
const RAW_ID = "wo-raw-entity-0001";

let dir: string;
let store: CrosslineStore;
let workspaceId: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "crossline-snapshot-"));
  store = new CrosslineStore(path.join(dir, "crossline.db"));
  workspaceId = store.createPrincipalWithWorkspace("auth-user", "个人 workspace").workspace.id;
});
afterEach(() => { store.close(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows */ } });

test("every column of every exported table, filled with free text, keeps none of it", () => {
  const tables = Object.keys((store.exportSnapshot(workspaceId) as { tables: Record<string, unknown[]> }).tables);
  expect(tables.length).toBeGreaterThan(30);
  const db = new Database(path.join(dir, "crossline.db"), { readonly: true });
  const fake: Record<string, Array<Record<string, unknown>>> = {};
  for (const table of tables) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    fake[table] = SECRETS.map((secret) => Object.fromEntries(columns.map((column) => [column.name, secret])));
  }
  db.close();
  const snapshot = redactedSnapshot({ exportSnapshot: () => ({ tables: fake }) as never }, workspaceId, "salt");
  const json = JSON.stringify(snapshot);
  for (const secret of SECRETS) expect(json).not.toContain(secret);
  expect(Object.keys(snapshot.tables).sort()).toEqual([...tables].sort());
});

test("a ledger written the normal way keeps its shape, times and states, and loses its words and raw ids", () => {
  const text = SECRETS.join(" ");
  store.appendEvent({ ownerId: "o", workspaceId, idempotencyKey: "k1", type: "capture.created", entityId: RAW_ID, payload: { title: text } });
  store.appendEvent({ ownerId: "o", workspaceId, idempotencyKey: "k2", type: "work_order.transitioned", entityId: RAW_ID, payload: { from: "approved", to: "active" } });
  store.setSetting(workspaceId, "schedule.preferences", JSON.stringify({ note: text }));
  const now = new Date().toISOString();
  store.saveOnboardingSession({ id: "s1", ownerId: "o", workspaceId, state: "active", coverage: { text }, createdAt: now, updatedAt: now });
  store.appendOnboardingMessage({ sessionId: "s1", workspaceId, role: "user", content: { text }, createdAt: now });
  const snapshot = redactedSnapshot(store, workspaceId, "salt", "0.2.0");
  const json = JSON.stringify(snapshot);
  for (const secret of [...SECRETS, RAW_ID]) expect(json).not.toContain(secret);
  const events = snapshot.tables.events!;
  expect(events.map((row) => row.type)).toEqual(["capture.created", "work_order.transitioned"]);
  expect(events[0]!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(events[0]!.entity_id).toBe(events[1]!.entity_id);
  expect(events[0]!.payload_json).toMatchObject({ len: expect.any(Number), h: expect.stringMatching(/^[0-9a-f]{16}$/) });
  expect(snapshot.tables.onboarding_messages![0]).toMatchObject({ role: "user", seq: 1 });
  expect(snapshot.tables.onboarding_sessions![0]).toMatchObject({ state: "active" });
  expect(snapshotSummary(snapshot).tables).toEqual(expect.arrayContaining([{ name: "events", rows: 2 }]));
});

test("hashes are keyed per install: the same text hashes differently elsewhere, so a short answer cannot be guessed back", () => {
  const a = redactCell("title", "是", "install-a") as { h: string };
  const b = redactCell("title", "是", "install-b") as { h: string };
  expect(a.h).not.toBe(b.h);
  expect(redactCell("state", "evidence_review", "s")).toBe("evidence_review");
  expect(redactCell("state", "一句自由文本", "s")).toMatchObject({ len: 6 });
  expect(redactCell("created_at", "not a time", "s")).toMatchObject({ len: 10 });
});

test("only the previewed object is uploaded, gzipped, with the note; nothing without a configured collector", async () => {
  const snapshot = redactedSnapshot(store, workspaceId, "salt", "0.2.0");
  const id = rememberPreview(workspaceId, snapshot);
  expect(takePreview("another-workspace", id)).toBeUndefined();
  const taken = takePreview(workspaceId, id)!;
  expect(takePreview(workspaceId, id)).toBeUndefined();
  expect(await uploadSnapshot(taken, "note", undefined, {})).toEqual({ ok: false, code: "COLLECTOR_NOT_CONFIGURED" });
  let sent: Buffer | undefined;
  const result = await uploadSnapshot(taken, "页面卡住了", "Me@Example.com", { CROSSLINE_TELEMETRY_URL: "https://c.example", CROSSLINE_INSTALL_ID: "i" },
    (async (_url: string | URL | Request, init?: RequestInit) => { sent = Buffer.from(init!.body as Uint8Array); return Response.json({ id: "snap-1" }); }) as typeof fetch);
  expect(result).toEqual({ ok: true, id: "snap-1" });
  const body = JSON.parse(gunzipSync(sent!).toString()) as Record<string, unknown>;
  expect(body.feedback).toBe("页面卡住了");
  expect(body.account).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(body)).not.toContain("Me@Example.com");
  expect(body.snapshot).toEqual(JSON.parse(JSON.stringify(snapshot)));
});
