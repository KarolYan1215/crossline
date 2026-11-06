import { expect, test } from "vitest";
import { CrosslineStore, latestFileDates } from "./index";

const WS = "w1";
const now = "2026-10-20T00:00:00.000Z";
const batch = (store: CrosslineStore, id: string, dates: Array<{ id: string; date: string; title: string }>) => store.appendEvent({ ownerId: "o", workspaceId: WS,
  idempotencyKey: `x:${id}`, type: "dates.extracted", entityId: id, payload: { dates: dates.map((item) => ({ ...item, project: "ece548", kind: "exam" })), undated: [] } });
const decide = (store: CrosslineStore, id: string, payload: object) => store.appendEvent({ ownerId: "o", workspaceId: WS, idempotencyKey: `d:${id}`,
  type: "dates.decided", entityId: id, payload });

test("the file dates read are every batch still in force, not just the newest (W-228: a lunch hour hid both midterms)", () => {
  const store = new CrosslineStore(":memory:");
  store.saveProject({ id: "ece548", ownerId: "o", workspaceId: WS, identityId: "research", name: "ECE 548", status: "active", summary: "", createdAt: now, updatedAt: now });
  batch(store, "a", [{ id: "m1", date: "2026-10-27", title: "期中 1" }, { id: "m2", date: "2026-11-24", title: "期中 2" }, { id: "no", date: "2026-11-01", title: "被本人拿掉" }]);
  decide(store, "a", { included: ["m1", "m2"], excluded: ["no"], by: "person" });
  batch(store, "old", [{ id: "x", date: "2026-11-02", title: "已被替换" }]);
  decide(store, "old", { superseded: true, by: "b" });
  batch(store, "b", [{ id: "f", date: "2026-12-10", title: "期末" }]);
  expect(latestFileDates(store, WS).dates.map((item) => item.title)).toEqual(["期中 1", "期中 2", "期末"]);
  store.close();
});

test("an item whose file named its day only relatively is kept for the question even with no project (W-228)", () => {
  const store = new CrosslineStore(":memory:");
  store.appendEvent({ ownerId: "o", workspaceId: WS, idempotencyKey: "x:r", type: "dates.extracted", entityId: "r", payload: { dates: [], undated: [
    { id: "u1", project: "", kind: "class", title: "补课", note: "relative:下周五补课" },
    { id: "u2", project: "", kind: "class", title: "没有项目也没有说法" }] } });
  expect(latestFileDates(store, WS).undated).toEqual([{ project: "", kind: "class", title: "补课", note: "relative:下周五补课" }]);
  store.close();
});
