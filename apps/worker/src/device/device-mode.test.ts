import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { RECORDING_TRANSCRIBED_EVENT, SLEEP_TRACKING_CONSENT, SOURCE_FOLDERS_SETTING, sourceFolderIndexSetting } from "@crossline/core";
import { createMemorySecretStore } from "@crossline/connectors";
import { CrosslineStore } from "@crossline/db";
import { ACTIVITY_DETAIL_CONSENT, LOCAL_ACTIVITY_CONSENT } from "../activity-recorder";
import { createDeviceLinkService, DEVICE_SECRET_NAME, DEVICE_SECRET_SLOT, linkFile, nodeEnabled, readDeviceLink } from "./link";
import { DEVICE_PASSES, MODEL_PASSES, PRIMARY_ONLY_PASSES, passesFor, workerMode } from "./mode";
import { activityItem, appToken, buildActivityPayload, readDeviceState, recordingItems, sourceItems } from "./payloads";

let dir: string;
let store: CrosslineStore;
let ws: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "crossline-device-"));
  store = new CrosslineStore(":memory:");
  ws = store.createPrincipalWithWorkspace("local-owner-principal", "个人").workspace.id;
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

test("a linked computer runs only the passes that read this machine — none of the model passes, none that act on the plan", () => {
  expect(workerMode(undefined)).toBe("full");
  expect(workerMode({ url: "https://app.crossline.lol" })).toBe("device");
  const device = passesFor("device");
  expect(device).toEqual(DEVICE_PASSES);
  for (const pass of [...MODEL_PASSES, ...PRIMARY_ONLY_PASSES]) expect(device).not.toContain(pass);
  expect(passesFor("full")).toEqual(expect.arrayContaining([...MODEL_PASSES, ...PRIMARY_ONLY_PASSES]));
});

test("the device worker's code imports no model runner, no Codex runtime and nothing that plans: it cannot spend the quota", () => {
  const here = import.meta.dirname;
  // Modules of the full worker that start Codex, run a Skill or change the plan. A device file importing one is a new path to the quota.
  const forbidden = /from "(?:\.\.\/)?(?:\.\/)?(?:analysis|goal-backplanner|step-planner|manualbook|milestone-[a-z-]+|onboarding-[a-z-]+|agent-(?:task|service|dispatch|tools)|automations|mailbox|graph-sync|calendar-[a-z-]+|concierge|diligence|flywheel|nightly|portrait-[a-z-]+|recording-digest|folder-classifier|sponsor|model-[a-z-]+|notify|dedupe|date-advance|return-tidy|work-split-repair|skill-library|public-skills|workflow-smith|insight-compiler)"|@crossline\/codex"(?!\/capability)/;
  expect(forbidden.test('import { createStepPlanner } from "../step-planner";')).toBe(true);
  expect(forbidden.test('import { startCodexSupervisor } from "@crossline/codex";')).toBe(true);
  expect(forbidden.test('import { agentHistoryPass } from "../agent-history";')).toBe(false);
  for (const file of readdirSync(here).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
    const source = readFileSync(path.join(here, file), "utf8");
    const imports = source.split("\n").filter((line) => /^import /.test(line));
    // The server shares the supervisor's folder routes (pure HTTP helpers), and nothing else of that package.
    const offending = imports.filter((line) => forbidden.test(line) && !/handleSourceFolderRequest, readJsonBody, sendJson/.test(line));
    expect(offending, file).toEqual([]);
    expect(source, file).not.toMatch(/startCodexSupervisor|runCodexSkill|startCodexAppServer|createModelProviderService/);
  }
});

test("the compute node is the one way a device runs Codex: only the raw app-server, only on the person's switch, and only for the site's requests", () => {
  const agent = readFileSync(path.join(import.meta.dirname, "..", "node", "agent.ts"), "utf8");
  const codexImports = agent.split("\n").filter((line) => /^import /.test(line) && line.includes("@crossline/codex"));
  expect(codexImports).toEqual(['import { spawnAppServerLines } from "@crossline/codex";']);
  // It answers and relays; it never starts a thread or a turn of its own.
  expect(agent).not.toMatch(/runCodexSkill|startCodexSupervisor|startCodexAppServer|method: "(?:thread|turn)\/start"/);
  // The device worker starts it only when the switch file says so.
  expect(readFileSync(path.join(import.meta.dirname, "worker.ts"), "utf8")).toMatch(/nodeEnabled\(dataDir\) && link\.token/);
});

test("the node switch is kept beside the link, needs a link first, restarts the worker when it changes, and goes with the link", async () => {
  const secrets = createMemorySecretStore();
  let restarts = 0;
  const service = createDeviceLinkService({ dataDir: dir, secrets, onChanged: () => { restarts += 1; }, nodeStatus: () => ({ state: "ready" }),
    fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch });
  expect(await service.handle("POST", "/v1/device/node", ws, { enabled: true })).toMatchObject({ status: 400, body: { code: "DEVICE_NOT_LINKED" } });
  await service.handle("POST", "/v1/device/link", ws, { url: "https://app.crossline.lol", token: "t".repeat(32) });
  restarts = 0;
  expect(await service.handle("POST", "/v1/device/node", ws, { enabled: true })).toMatchObject({ status: 200, body: { enabled: true } });
  expect(nodeEnabled(dir)).toBe(true);
  expect(restarts).toBe(1);
  // Saying the same again changes nothing and restarts nothing.
  await service.handle("POST", "/v1/device/node", ws, { enabled: true });
  expect(restarts).toBe(1);
  expect((await service.handle("GET", "/v1/device/link", ws, undefined))!.body).toMatchObject({ node: { enabled: true, status: { state: "ready" } } });
  await service.handle("DELETE", "/v1/device/link", ws, undefined);
  expect(nodeEnabled(dir)).toBe(false);
});

test("the activity snapshot carries no window title and no app name, only a salted token; nothing changes, nothing is queued", () => {
  store.setSetting(ws, LOCAL_ACTIVITY_CONSENT, "granted");
  store.setSetting(ws, ACTIVITY_DETAIL_CONSENT, "granted");
  store.setSetting(ws, SLEEP_TRACKING_CONSENT, "granted");
  const at = new Date();
  at.setUTCMinutes(0, 0, 0);
  store.recordActivityReading({ workspaceId: ws, at: at.toISOString(), intervalSeconds: 60, app: "WINWORD.EXE", title: "离婚协议.docx", category: "writing", idle: false });
  const state = readDeviceState(dir);
  const payload = buildActivityPayload(store, ws, state);
  const text = JSON.stringify(payload);
  expect(text).not.toContain("离婚协议");
  expect(text).not.toContain("WINWORD");
  expect(payload.segments[0]).toMatchObject({ category: "writing", app: appToken(state.salt, "WINWORD.EXE") });
  expect(payload.segments[0]!.app).toMatch(/^[a-f0-9]{8}$/);
  expect(payload.consents).toMatchObject({ activity: true, detail: true, sleep: true, rhythm: false });
  // The first send carries the last weeks; the next the last two days; after that, the same snapshot is not queued again.
  expect(activityItem(store, ws, state)).toMatchObject({ route: "/api/device/activity", supersedes: "activity" });
  activityItem(store, ws, state);
  expect(activityItem(store, ws, state)).toBeUndefined();
});

test("folder files are queued once each by sha256, transcripts go as recordings, and a dropped file is queued for removal", () => {
  store.setSetting(ws, SOURCE_FOLDERS_SETTING, JSON.stringify([{ id: "f1", path: "C:\\Users\\karol\\Downloads", label: "Downloads", addedAt: "", lines: ["research"], linesBy: "person", files: 2 }]));
  const owner = store.getWorkspaceOwnerId(ws)!;
  const doc = (id: string, sha: string, fileName: string, text: string) => store.saveSourceDocument({ id, ownerId: owner, workspaceId: ws, kind: "text", fileName,
    mediaType: "text/plain", sha256: sha, uri: "file:///x", extractedText: text, extractionStatus: "done", createdAt: "2026-10-21T00:00:00.000Z" });
  doc("d1", "a".repeat(64), "Downloads/syllabus.txt", "ECE 555");
  doc("d2", "b".repeat(64), "Downloads/录音.m4a 转写.txt", "[00:01] 明天交报告");
  store.setSetting(ws, sourceFolderIndexSetting("f1"), JSON.stringify({ "syllabus.txt": { size: 1, mtimeMs: 1, documentId: "d1", created: true },
    "录音.m4a": { size: 1, mtimeMs: 1, documentId: "d2", audio: "done" } }));
  store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: `t:${"c".repeat(64)}`, type: RECORDING_TRANSCRIBED_EVENT, entityId: "c".repeat(64),
    payload: { fileName: "录音.m4a", seconds: 60, speechSeconds: 30, workMs: 1, wallMs: 1, documentId: "d2", folderId: "f1" } });

  const state = readDeviceState(dir);
  const first = sourceItems(store, ws, state);
  expect(first.map((item) => item.id.split(":")[0])).toEqual(["folders", "sources"]);
  const documents = (first[1]!.body as { documents: Array<{ sha256: string }> }).documents;
  expect(documents.map((item) => item.sha256)).toEqual(["a".repeat(64)]);
  expect(JSON.stringify(first[0]!.body)).not.toContain("karol");
  expect(sourceItems(store, ws, state)).toEqual([]);
  const recordings = recordingItems(store, ws, state);
  expect(recordings).toHaveLength(1);
  expect((recordings[0]!.body as { transcripts: Array<{ text: string; label: string }> }).transcripts[0]).toMatchObject({ text: "[00:01] 明天交报告", label: "Downloads" });
  expect(recordingItems(store, ws, state)).toEqual([]);

  store.deleteSourceDocument(ws, "d1");
  store.setSetting(ws, sourceFolderIndexSetting("f1"), JSON.stringify({ "录音.m4a": { size: 1, mtimeMs: 1, documentId: "d2", audio: "done" } }));
  expect(sourceItems(store, ws, state).map((item) => item.body)).toEqual([{ remove: ["a".repeat(64)] }]);
});

test("linking checks the token against the site before keeping it, keeps the token only in the secret store, and restarts the worker", async () => {
  const secrets = createMemorySecretStore();
  let restarts = 0;
  const answers = [401, 200];
  const service = createDeviceLinkService({ dataDir: dir, secrets, onChanged: () => { restarts += 1; },
    fetch: (async () => new Response("{}", { status: answers.shift() ?? 200 })) as typeof fetch });
  const token = "t".repeat(32);
  expect(await service.handle("POST", "/v1/device/link", ws, { url: "http://example.com", token })).toMatchObject({ status: 400, body: { code: "DEVICE_URL_INVALID" } });
  expect(await service.handle("POST", "/v1/device/link", ws, { url: "https://app.crossline.lol", token })).toMatchObject({ status: 400, body: { code: "DEVICE_TOKEN_INVALID" } });
  expect(existsSync(linkFile(dir))).toBe(false);
  expect(await service.handle("POST", "/v1/device/link", ws, { url: "https://app.crossline.lol/settings?x=1", token })).toMatchObject({ status: 200, body: { url: "https://app.crossline.lol" } });
  expect(restarts).toBe(1);
  expect(readFileSync(linkFile(dir), "utf8")).not.toContain(token);
  expect(await secrets.read(DEVICE_SECRET_SLOT, DEVICE_SECRET_NAME)).toBe(token);
  expect(await readDeviceLink(dir, secrets)).toMatchObject({ url: "https://app.crossline.lol", token });
  expect(await service.handle("DELETE", "/v1/device/link", ws, undefined)).toMatchObject({ status: 200, body: { linked: false } });
  expect(await readDeviceLink(dir, secrets)).toBeUndefined();
  expect(restarts).toBe(2);
});
