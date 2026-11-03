import { expect, test } from "vitest";
import { CrosslineStore, isWorkspaceMirror, mirrorLocalSetting, mirrorSnapshot, replaceWorkspaceFrom, type StoredSourceDocument } from "./index";

const doc = (store: CrosslineStore, workspaceId: string, id: string, sha: string, text: string): StoredSourceDocument =>
  store.saveSourceDocument({ id, ownerId: store.getWorkspaceOwnerId(workspaceId)!, workspaceId, kind: "text", fileName: `${id}.txt`, mediaType: "text/plain",
    sha256: sha.repeat(64), uri: `file:///x/${id}.txt`, extractedText: text, extractionStatus: "done", createdAt: "2026-11-01T00:00:00.000Z" });
const event = (store: CrosslineStore, workspaceId: string, key: string, type: string, payload: Record<string, unknown> = {}) =>
  store.appendEvent({ ownerId: store.getWorkspaceOwnerId(workspaceId)!, workspaceId, idempotencyKey: key, type, entityId: key, payload });

test("the hosted side leaves out machine settings, token hashes and identity tables", () => {
  const server = new CrosslineStore(":memory:");
  const ws = server.createPrincipalWithWorkspace("hosted", "个人").workspace.id;
  server.setSetting(ws, "schedule.lineShares", "{}");
  for (const key of ["device.token.sha256", "capture.token.sha256", "deployment.runtimeOwner", "mail.accounts", "device.recent", "node.status"]) server.setSetting(ws, key, "x");
  const mirror = mirrorSnapshot(server, ws);
  expect(isWorkspaceMirror(mirror)).toBe(true);
  expect(mirror.tables.settings!.map((row) => row.key)).toEqual(["schedule.lineShares"]);
  expect(mirror.tables.principals).toBeUndefined();
  expect(mirror.tables.workspace_members).toBeUndefined();
  expect(mirrorLocalSetting("recording.token.sha256")).toBe(true);
  server.close();
});

test("a mirror replaces the local workspace's rows, keeps what the device holds for itself, and leaves another workspace alone", () => {
  const server = new CrosslineStore(":memory:");
  const sw = server.createPrincipalWithWorkspace("hosted", "个人").workspace.id;
  const serverOwner = server.getWorkspaceOwnerId(sw)!;
  server.setSetting(sw, "schedule.lineShares", JSON.stringify({ owner: serverOwner }));
  server.setSetting(sw, "activity.hourly", "server copy");
  event(server, sw, "task-1", "work_order.created");
  doc(server, sw, "upload-1", "a", "syllabus");
  doc(server, sw, "device-aaaa", "b", "notes from the folder");
  event(server, sw, "fact-1", "profile.fact", { documentId: "device-aaaa" });
  event(server, sw, "recording.transcribed:c", "recording.transcribed", { where: "device" });

  const local = new CrosslineStore(":memory:");
  const lw = local.createPrincipalWithWorkspace("local", "个人").workspace.id;
  const ow = local.createPrincipalWithWorkspace("other", "别人").workspace.id;
  const localOwner = local.getWorkspaceOwnerId(lw)!;
  local.setSetting(ow, "schedule.lineShares", "other's");
  event(local, ow, "other-1", "work_order.created");
  local.setSetting(lw, "schedule.lineShares", "stale");
  local.setSetting(lw, "activity.hourly", "this machine");
  local.setSetting(lw, "sources.folders", "[folders]");
  event(local, lw, "old-1", "work_order.created");
  doc(local, lw, "folder-doc", "b", "notes from the folder");
  doc(local, lw, "folder-new", "d", "not sent yet");
  doc(local, lw, "stale-upload", "e", "gone on the site");
  event(local, lw, "recording.transcribed:c", "recording.transcribed", { where: "本机转写" });
  local.replaceDeviceActivitySegments(lw, "2026-11-01T00:00:00.000Z", [{ start: "2026-11-01T10:00:00.000Z", end: "2026-11-01T10:30:00.000Z", app: "code.exe", category: "coding", idle: false }]);

  const keep = (table: string, row: Record<string, unknown>) => table === "source_documents" ? ["folder-doc", "folder-new"].includes(String(row.id))
    : table === "events" && String(row.type).startsWith("recording.");
  replaceWorkspaceFrom(local, mirrorSnapshot(server, sw), { workspaceId: lw, keep, spare: ["activity_segments"] });

  // The site's rows, under the local ids.
  expect(JSON.parse(local.getSetting(lw, "schedule.lineShares")!)).toEqual({ owner: localOwner });
  expect(local.listEvents(lw).map((item) => item.idempotencyKey).sort()).toEqual(["fact-1", "recording.transcribed:c", "task-1"]);
  // The device's own: its settings, its transcript event (not the site's copy of it), its folder files and its screen segments.
  expect(local.getSetting(lw, "activity.hourly")).toBe("this machine");
  expect(local.getSetting(lw, "sources.folders")).toBe("[folders]");
  expect(local.listEvents(lw, { type: "recording.transcribed" })[0]!.payload).toEqual({ where: "本机转写" });
  const docs = new Map(local.listSourceDocuments(lw).map((item) => [item.id, item]));
  expect([...docs.keys()].sort()).toEqual(["folder-doc", "folder-new", "upload-1"]);
  // The site's copy of a folder file gives way to the device's, which takes its number; the site's references follow it.
  expect(docs.get("folder-doc")!.refNo).toBe(server.listSourceDocuments(sw).find((item) => item.id === "device-aaaa")!.refNo);
  expect(local.listEvents(lw, { type: "profile.fact" })[0]!.payload).toEqual({ documentId: "folder-doc" });
  const numbers = [...docs.values()].map((item) => item.refNo);
  expect(new Set(numbers).size).toBe(numbers.length);
  expect(local.listActivitySegments(lw, "2026-11-01T00:00:00.000Z")).toHaveLength(1);
  expect(local.recentActivityEntries(lw, 5)[0]!.app).toBe("code.exe");
  // The other workspace in this file is untouched.
  expect(local.getSetting(ow, "schedule.lineShares")).toBe("other's");
  expect(local.listEvents(ow).map((item) => item.idempotencyKey)).toEqual(["other-1"]);

  // Mirroring again is the same: nothing piles up.
  replaceWorkspaceFrom(local, mirrorSnapshot(server, sw), { workspaceId: lw, keep, spare: ["activity_segments"] });
  expect(local.listSourceDocuments(lw)).toHaveLength(3);
  expect(local.listEvents(lw)).toHaveLength(3);
  server.close();
  local.close();
});
