import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { APP_PAGES, DERIVED_EVENT_TYPES, LEDGER_EVENT_TYPES, TELEMETRY_COUNT_FIELDS, TELEMETRY_FIELDS, TELEMETRY_TOKEN_FIELDS,
  sanitizeTelemetryBatch, sanitizeTelemetryEvent } from "@crossline/core";

/**
 * An installed copy reports how it is used to the owner's collector, and the promise made to the person is that nothing they wrote
 * goes with it (docs/local-installer.md, 回传). Like the activity-title rule, that is a property of what code can *reach* the
 * collector, so it is checked by walking the source, then by throwing everything at the one gate every byte passes through.
 * `apps/worker/src/telemetry.test.ts` runs the sender itself over a ledger full of a person's words.
 */
const ROOTS = ["apps/web", "apps/worker/src", "apps/launcher/src", "packages"];
const SKIP = new Set(["node_modules", ".next", ".next-e2e", ".next-prod", "dist"]);
const root = path.resolve(import.meta.dirname, "../../..");

function collect(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
  }
  return out;
}
const files = ROOTS.flatMap((dir) => collect(path.join(root, dir)));
const rel = (file: string) => path.relative(root, file).replaceAll("\\", "/");
const using = (needle: RegExp) => files.filter((file) => needle.test(readFileSync(file, "utf8"))).map(rel).sort();

test("the collector's address is known to the launcher that sets it and the two senders that use it — nothing else", () => {
  expect(using(/CROSSLINE_TELEMETRY_URL/)).toEqual([
    "apps/launcher/src/supervise.ts", "apps/web/lib/diagnostic-snapshot.ts", "apps/worker/src/index.ts", "apps/worker/src/telemetry.ts"]);
  // The first read of every source file in the tree: past the 5 s default under a full-suite load (5.6 s on 2026-10-14).
}, 30_000);

test("the usage sender posts exactly one thing: the batch that came out of the whitelist", () => {
  const source = readFileSync(path.join(root, "apps/worker/src/telemetry.ts"), "utf8");
  expect(source.match(/fetch\)?\(/g)).toHaveLength(1);
  expect(source).toMatch(/const batch: TelemetryBatch \| undefined = sanitizeTelemetryBatch\(/);
  expect(source).toMatch(/body: JSON\.stringify\(batch\)/);
  expect(source.match(/body:/g)).toHaveLength(1);
});

test("a page is reported only as one of the app's own route templates, and the list is every page there is", () => {
  const pages = collect(path.join(root, "apps/web/app")).filter((file) => file.endsWith(`${path.sep}page.tsx`))
    .map((file) => `/${path.relative(path.join(root, "apps/web/app"), path.dirname(file)).replaceAll("\\", "/")}`.replace(/\/$/, "") || "/")
    .map((page) => page === "/." ? "/" : page).sort();
  expect([...APP_PAGES].sort()).toEqual(pages);
});

/** Deterministic noise: free text in every shape a person's words take, in every field, nested and not. */
const POISON = ["任务：给导师写信", "draft final.docx", "https://private.example/a?b=c", "C:\\Users\\someone\\secret.txt", "a person@example.com",
  "Secret free text", "lower words", "/workbench/abc123", "<script>", "12345678-aaaa-bbbb-cccc-1234567890ab"];

test("the gate keeps only whitelisted keys whose values pass their checks, whatever it is handed", () => {
  const pages = new Set<string>(APP_PAGES);
  const types = [...LEDGER_EVENT_TYPES, ...DERIVED_EVENT_TYPES, "task.note", "conversation.message", "profile.fact"];
  let kept = 0;
  for (const [index, type] of types.entries()) for (const poison of POISON) {
    const event = { type, at: "2026-10-13T12:00:00.000Z", version: "0.2.0", page: poison, stage: poison, skill: poison, code: poison, entity: poison,
      ms: poison, repairs: poison, ok: poison, tokens: { input: poison, cached: 1, output: 2, extra: 3 }, counts: { captures: 1, title: poison },
      title: poison, text: poison, payload: { poison }, [`field${index}`]: poison };
    const out = sanitizeTelemetryEvent(event, pages);
    if (!(LEDGER_EVENT_TYPES as readonly string[]).includes(type) && !(DERIVED_EVENT_TYPES as readonly string[]).includes(type)) { expect(out).toBeUndefined(); continue; }
    expect(out).toBeDefined();
    kept += 1;
    const serialized = JSON.stringify(out);
    for (const word of POISON) expect(serialized).not.toContain(word);
    for (const key of Object.keys(out!)) expect(TELEMETRY_FIELDS).toContain(key);
    expect(Object.keys(out!.tokens ?? {}).every((key) => (TELEMETRY_TOKEN_FIELDS as readonly string[]).includes(key))).toBe(true);
    expect(Object.keys(out!.counts ?? {}).every((key) => (TELEMETRY_COUNT_FIELDS as readonly string[]).includes(key))).toBe(true);
  }
  expect(kept).toBeGreaterThan(30);
  // An event without a valid time or version is not sent at all.
  expect(sanitizeTelemetryEvent({ type: "capture.created", at: "yesterday", version: "0.2.0" }, pages)).toBeUndefined();
  expect(sanitizeTelemetryEvent({ type: "capture.created", at: "2026-10-13T12:00:00.000Z", version: "some text" }, pages)).toBeUndefined();
});

test("the batch envelope carries the install id, a hash of the account and nothing a person typed", () => {
  const batch = sanitizeTelemetryBatch({ install: "not-an-id but text", version: "0.2.0", sentAt: "2026-10-13T12:00:00.000Z", events: [] }, new Set());
  expect(batch).toBeUndefined();
  const ok = sanitizeTelemetryBatch({ install: "6b0c7f2e-2b7a-4c55-9c1e-8e5c2f0a4d11", account: "me@example.com", version: "0.2.0",
    sentAt: "2026-10-13T12:00:00.000Z", events: [] }, new Set());
  expect(ok).toEqual({ install: "6b0c7f2e-2b7a-4c55-9c1e-8e5c2f0a4d11", version: "0.2.0", sentAt: "2026-10-13T12:00:00.000Z", events: [] });
});
