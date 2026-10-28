import { mkdirSync, readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { IMPORT_SEEN_SETTING, IMPORT_SOURCES_SETTING, type ImportBatch } from "@crossline/core";
import type { ImportFetch, SecretStore } from "@crossline/connectors";
import { CrosslineStore } from "@crossline/db";
import { confirmBatch, connectSource, createImportService, importBatches, importDailyPass, importedDueDate, importFile, IMPORT_TRIAGE_SKILL, removeSource,
  setSourceOptions, sortBatch, startBatch, writeBackPass, type ImportDeps } from "./importer";
import { recordWaitingAndDates } from "./analysis";
import { fakeRuntime } from "./testing/fake-runtime";

const FIXTURES = path.join(import.meta.dirname, "testing", "fixtures");
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), "utf8");
const todoist = JSON.parse(fixture("import-todoist.json")) as Record<string, unknown>;

const memorySecrets = (): SecretStore & { values: Map<string, string> } => {
  const values = new Map<string, string>();
  return { values, read: async (w, n) => values.get(`${w}/${n}`), write: async (w, n, v) => { values.set(`${w}/${n}`, v); }, remove: (w, n) => { values.delete(`${w}/${n}`); } };
};
/** Todoist's API v1 as the fixture says it answers: two pages of tasks, one of projects, `close` recorded; a wrong token is refused. */
function todoistApi(token = "tok-123") {
  const closed: string[] = [];
  const calls: string[] = [];
  const fetchImpl: ImportFetch = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    const answer = (status: number, body?: unknown) => ({ ok: status < 400, status, json: async () => body, text: async () => body === undefined ? "" : JSON.stringify(body) });
    if (init.headers.authorization !== `Bearer ${token}`) return answer(401, { error: "Unauthorized" });
    const close = /\/tasks\/([^/]+)\/close$/.exec(url);
    if (close && init.method === "POST") { closed.push(close[1]!); return answer(204); }
    if (url.includes("/projects")) return answer(200, todoist.projects);
    if (url.includes("/tasks")) return answer(200, url.includes("cursor=") ? todoist.tasksPage2 : todoist.tasksPage1);
    return answer(404);
  };
  return { fetchImpl, closed, calls };
}

let store: CrosslineStore;
let dataDir: string;
afterEach(() => { store?.close(); if (dataDir) rmSync(dataDir, { recursive: true, force: true }); });
const setup = (extra: Partial<ImportDeps> = {}) => {
  store = new CrosslineStore(":memory:");
  const workspaceId = store.createPrincipalWithWorkspace("user-1", "w").workspace.id;
  dataDir = mkdtempSync(path.join(tmpdir(), "crossline-import-"));
  const secrets = memorySecrets();
  const deps: ImportDeps = { store, secrets, dataDir, cwd: "/repo", client: () => undefined, sortAllowed: async () => true, timeZone: () => "Asia/Shanghai",
    now: () => new Date("2026-10-28T02:00:00Z"), ...extra };
  return { workspaceId, secrets, deps };
};
const estimate = { p25Minutes: 30, p50Minutes: 45, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };
const openTask = (workspaceId: string, id: string, title: string, identityId = "research") => store.saveWorkOrder({ id, ownerId: "user-1", workspaceId, identityId,
  projectId: "ece555", milestoneId: "", intent: title, state: "approved", riskTier: "routine", estimate, payload: { title } });
const triageAnswer = (items: Array<Record<string, string>>) => JSON.stringify({ items: items.map((item) => ({ lineId: "", project: "", due: "", duplicateOf: "", why: "", ...item })) });

test("a Todoist token is kept only after a read works, only in the secret store; every page is read and a batch offered", async () => {
  const api = todoistApi();
  const { workspaceId, secrets, deps } = setup({ fetch: api.fetchImpl });
  expect(await connectSource(deps, workspaceId, { kind: "todoist", token: "wrong" })).toMatchObject({ ok: false, code: "IMPORT_TOKEN_REFUSED" });
  expect(secrets.values.size).toBe(0);
  const connected = await connectSource(deps, workspaceId, { kind: "todoist", token: "tok-123" });
  expect(connected).toMatchObject({ ok: true, source: { kind: "todoist", daily: true, writeBack: false, lastItems: 4 } });
  expect(api.calls.filter((call) => call.includes("/tasks"))).toHaveLength(2);
  expect([...secrets.values.values()]).toEqual(["tok-123"]);
  expect(JSON.stringify(store.exportSnapshot(workspaceId))).not.toContain("tok-123");
  const [batch] = importBatches(store, workspaceId);
  expect(batch!.items.map((item) => [item.title, item.due, item.list])).toEqual([["Submit HW4", "2026-11-03", "ECE 555"], ["整理 ECE 555 课堂笔记", "", "ECE 555"],
    // The deadline wins over the due day.
    ["报名秋季马拉松", "2026-08-30", "Personal"], ["学日语", "", "Personal"]]);
  // Disconnecting deletes the token at once and the waiting batch with it.
  if (connected.ok && "source" in connected) expect(removeSource(deps, workspaceId, connected.source.id)).toBe(true);
  expect(secrets.values.size).toBe(0);
  expect(importBatches(store, workspaceId)).toEqual([]);
});

test("one triage run sorts the batch; a keep the rules find on the board becomes a merge; confirming writes only kept items, once", async () => {
  const api = todoistApi();
  const { rpc } = fakeRuntime([triageAnswer([
    { key: "i1", decision: "keep", lineId: "research", project: "ECE 555", due: "2026-11-03" },
    // The model missed the duplicate: the rules catch it.
    { key: "i2", decision: "keep", lineId: "research", project: "ECE 555" },
    { key: "i3", decision: "drop", why: "报名截止已过" },
    { key: "i4", decision: "someday", why: "愿望，没有下一步" }])], IMPORT_TRIAGE_SKILL);
  let analysed = 0;
  const { workspaceId, deps } = setup({ fetch: api.fetchImpl, client: () => rpc, onCaptured: () => { analysed += 1; } });
  openTask(workspaceId, "notes", "整理 ECE 555 课堂笔记");
  const connected = await connectSource(deps, workspaceId, { kind: "todoist", token: "tok-123" });
  const batchId = connected.ok && "batchId" in connected ? connected.batchId! : "";
  const sorted = await sortBatch(deps, workspaceId, batchId) as ImportBatch;
  expect(sorted).toMatchObject({ state: "ready", sorted: true });
  expect(sorted.items.map((item) => [item.suggestion.decision, item.suggestion.duplicateOf])).toEqual([["keep", ""], ["merge", "notes"], ["drop", ""], ["someday", ""]]);
  // The person keeps the ticked ones and also ticks 「学日语」 under the investment line.
  const outcome = confirmBatch(deps, workspaceId, batchId, [{ key: "i4", keep: true, lineId: "investment" }]);
  expect(outcome).toEqual({ ok: true, captured: 2, merged: 1, skipped: 1 });
  expect(analysed).toBe(1);
  const captures = store.listCaptures(workspaceId);
  expect(captures.map((capture) => capture.id).sort()).toEqual(["import-todoist-6X7rM8997g3RQmvh", "import-todoist-6X7rfEVP8hvv25ZR"]);
  expect(captures.find((capture) => capture.id === "import-todoist-6X7rM8997g3RQmvh")!.context).toContain("2026-11-03");
  expect(store.listEvents(workspaceId, { type: "task.duplicate_prevented", entityId: "notes" })).toHaveLength(1);
  // Read again: nothing is offered twice, and confirming the same items again writes nothing.
  const again = await connectSource(deps, workspaceId, { kind: "todoist", token: "tok-123" });
  expect(again.ok && "batchId" in again ? again.batchId : undefined).toBeUndefined();
  expect(Object.values(JSON.parse(store.getSetting(workspaceId, IMPORT_SEEN_SETTING)!) as Record<string, string[]>)[0]).toHaveLength(4);
});

test("without a model the rules' suggestions stand: done items unticked, everything else kept", async () => {
  const { workspaceId, deps } = setup();
  const batch = startBatch(deps, workspaceId, { kind: "text", sourceId: "", label: "粘贴", items: [
    { kind: "text", externalId: "a", title: "交作业", notes: "", due: "", labels: [], list: "", done: false, createdAt: "" },
    { kind: "text", externalId: "b", title: "回邮件", notes: "", due: "", labels: [], list: "", done: true, createdAt: "" }] })!;
  const sorted = await sortBatch(deps, workspaceId, batch.id);
  expect(sorted).toMatchObject({ state: "ready", sorted: false });
  expect(confirmBatch(deps, workspaceId, batch.id)).toEqual({ ok: true, captured: 1, merged: 0, skipped: 1 });
});

test("a triage answer that skips an item or names an unknown line or task is sent back with the item named", async () => {
  const { rpc, prompts } = fakeRuntime([
    triageAnswer([{ key: "i1", decision: "merge", duplicateOf: "nope", lineId: "cooking" }]),
    triageAnswer([{ key: "i1", decision: "keep", lineId: "research" }, { key: "i2", decision: "done", why: "已勾选" }])], IMPORT_TRIAGE_SKILL);
  const { workspaceId, deps } = setup({ client: () => rpc });
  const batch = startBatch(deps, workspaceId, { kind: "text", sourceId: "", label: "x", items: [
    { kind: "text", externalId: "a", title: "交作业", notes: "", due: "", labels: [], list: "", done: false, createdAt: "" },
    { kind: "text", externalId: "b", title: "回邮件", notes: "", due: "", labels: [], list: "", done: false, createdAt: "" }] })!;
  const sorted = await sortBatch(deps, workspaceId, batch.id);
  expect(sorted?.sorted).toBe(true);
  expect(prompts().at(-1)).toContain("cooking");
  expect(sorted?.items.map((item) => item.suggestion.decision)).toEqual(["keep", "done"]);
});

test("a pasted list, a TickTick backup CSV and a file the web stored are read once and the file deleted", async () => {
  const { workspaceId, deps } = setup();
  const folder = path.join(dataDir, "imports", workspaceId);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, "paste-0001.txt"), fixture("import-pasted-list.txt"));
  writeFileSync(path.join(folder, "backup-0001.csv"), fixture("import-ticktick-backup.csv"));
  const pasted = await importFile(deps, workspaceId, { file: "paste-0001.txt", kind: "text" });
  expect(pasted).toMatchObject({ ok: true, items: 5 });
  expect(existsSync(path.join(folder, "paste-0001.txt"))).toBe(false);
  const csv = await importFile(deps, workspaceId, { file: "backup-0001.csv", kind: "csv", name: "TickTick 备份" });
  expect(csv).toMatchObject({ ok: true, items: 3 });
  const ticktick = importBatches(store, workspaceId).find((batch) => batch.kind === "csv")!;
  expect(ticktick.items.map((item) => [item.title, item.done, item.due, item.list])).toEqual([["回复导师邮件", true, "", "收集箱"],
    // An all-day task stored at local midnight is that local day.
    ["Midterm review, chapters 1-6", false, "2026-11-06", "ECE 555"], ["买牙膏", false, "", "收集箱"]]);
  expect(await importFile(deps, workspaceId, { file: "../escape.txt", kind: "text" })).toMatchObject({ ok: false, code: "IMPORT_FILE_INVALID" });
  // A screenshot needs the picture reader.
  writeFileSync(path.join(folder, "shot-00001.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  expect(await importFile(deps, workspaceId, { file: "shot-00001.png", kind: "image" })).toMatchObject({ ok: false, code: "IMPORT_IMAGE_UNAVAILABLE" });
  writeFileSync(path.join(folder, "shot-00002.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const read = await importFile({ ...deps, describe: () => async () => [{ id: "shot", description: "清单截图", text: "[ ] 订机票 2026-12-20\n[x] 交房租" }] }, workspaceId,
    { file: "shot-00002.png", kind: "image" });
  expect(read).toMatchObject({ ok: true, items: 2 });
});

test("a Notion token with no database answers with the databases shared with it; the chosen one is read", async () => {
  const pages = JSON.parse(fixture("import-notion.json"));
  const fetchImpl: ImportFetch = async (url) => {
    const body = url.endsWith("/search") ? { results: [{ object: "database", id: "1a2b3c4d-0000-0000-0000-000000000001", title: [{ plain_text: "创业待办" }] }] } : pages;
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  const { workspaceId, secrets, deps } = setup({ fetch: fetchImpl });
  expect(await connectSource(deps, workspaceId, { kind: "notion", token: "ntn_x" })).toEqual({ ok: true, databases: [{ id: "1a2b3c4d-0000-0000-0000-000000000001", title: "创业待办" }] });
  expect(secrets.values.size).toBe(0);
  const connected = await connectSource(deps, workspaceId, { kind: "notion", token: "ntn_x", databaseId: "1a2b3c4d-0000-0000-0000-000000000001" });
  expect(connected).toMatchObject({ ok: true, source: { label: "创业待办", databaseTitle: "创业待办" } });
  expect(importBatches(store, workspaceId)[0]!.items.map((item) => [item.title, item.done, item.due, item.labels.join(",")]))
    .toEqual([["写 MVP 落地页文案", false, "2026-11-10", "startup,copy"], ["联系三位潜在用户", true, "", ""]]);
});

test("a Todoist task finished in Crossline is closed in Todoist only once write-back is on, and only once", async () => {
  const api = todoistApi();
  const { workspaceId, deps } = setup({ fetch: api.fetchImpl });
  const connected = await connectSource(deps, workspaceId, { kind: "todoist", token: "tok-123" });
  const source = connected.ok && "source" in connected ? connected.source : undefined;
  confirmBatch(deps, workspaceId, importBatches(store, workspaceId)[0]!.id);
  // The analysis promotes the capture under the same id; the person finishes it.
  store.saveWorkOrder({ id: "import-todoist-6X7rM8997g3RQmvh", ownerId: "user-1", workspaceId, identityId: "research", projectId: "", milestoneId: "", intent: "Submit HW4",
    state: "accepted", riskTier: "routine", estimate, payload: { title: "Submit HW4" } });
  expect(await writeBackPass(deps, workspaceId)).toBe(0);
  expect(setSourceOptions(store, workspaceId, source!.id, { writeBack: true })).toBe(true);
  expect(await writeBackPass(deps, workspaceId)).toBe(1);
  expect(api.closed).toEqual(["6X7rM8997g3RQmvh"]);
  expect(await writeBackPass(deps, workspaceId)).toBe(0);
});

test("an imported due day reaches the task when the analysis read none", () => {
  const { workspaceId, deps } = setup();
  const batch = startBatch(deps, workspaceId, { kind: "text", sourceId: "", label: "x", items: [
    { kind: "text", externalId: "abc", title: "交作业 4", notes: "", due: "2026-11-03", labels: [], list: "", done: false, createdAt: "" }] })!;
  confirmBatch(deps, workspaceId, batch.id);
  expect(importedDueDate(store, workspaceId, "import-text-abc")).toBe("2026-11-03");
  store.saveWorkOrder({ id: "import-text-abc", ownerId: "user-1", workspaceId, identityId: "research", projectId: "", milestoneId: "", intent: "交作业 4",
    state: "awaiting_plan_approval", riskTier: "routine", estimate, payload: { title: "交作业 4" } });
  recordWaitingAndDates(store, workspaceId, "import-text-abc");
  expect((store.getWorkOrder(workspaceId, "import-text-abc")!.payload as { dueDate?: string }).dueDate).toBe("2026-11-03");
});

test("the daily read applies a sorted batch by itself and tells the person once; switched off, nothing is read", async () => {
  const api = todoistApi();
  const answers = [triageAnswer([{ key: "i1", decision: "keep", lineId: "research" }, { key: "i2", decision: "keep", lineId: "research" },
    { key: "i3", decision: "drop", why: "过期" }, { key: "i4", decision: "someday", why: "愿望" }])];
  const { rpc } = fakeRuntime(answers, IMPORT_TRIAGE_SKILL);
  let now = new Date("2026-10-28T02:00:00Z");
  const { workspaceId, deps } = setup({ fetch: api.fetchImpl, client: () => rpc, now: () => now });
  const connected = await connectSource(deps, workspaceId, { kind: "todoist", token: "tok-123" });
  // The first batch is the person's to confirm; the daily read waits for it.
  expect((await importDailyPass(deps, workspaceId)).read).toBe(0);
  const service = createImportService(deps);
  expect(await service.handle("DELETE", `/v1/import/batches/${importBatches(store, workspaceId)[0]!.id}`, workspaceId, {})).toEqual({ status: 200, body: { ok: true } });
  now = new Date("2026-10-29T04:00:00Z");
  const pass = await importDailyPass(deps, workspaceId);
  expect(pass).toMatchObject({ read: 1, captured: 2 });
  expect(store.listCaptures(workspaceId)).toHaveLength(2);
  expect(importBatches(store, workspaceId)).toEqual([]);
  const source = connected.ok && "source" in connected ? connected.source : undefined;
  setSourceOptions(store, workspaceId, source!.id, { daily: false });
  now = new Date("2026-10-31T04:00:00Z");
  expect((await importDailyPass(deps, workspaceId)).read).toBe(0);
  expect(JSON.parse(store.getSetting(workspaceId, IMPORT_SOURCES_SETTING)!)[0]).toMatchObject({ daily: false });
});
