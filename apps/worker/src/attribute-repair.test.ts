import { expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { LINE_ATTRIBUTE_REPAIR, repairLineAttributes } from "./attribute-repair";

const ws = "w";
const owner = "o";

// The real account's research line, 2026-10-21: chips read from replies and files before the adjective rule, one adopted goal part among them.
const profiles = {
  research: { description: "研究线", attributes: [
    { text: "神经形态计算", kind: "domain", sourceRef: "reply-1" },
    { text: "外推知识边界", kind: "state", sourceRef: "src-5" },
    { text: "把脑机制转化为计算机制与硬件结构", kind: "ability", sourceRef: "goal" },
    { text: "以真实技术链条和可复现证据工作", kind: "ability", sourceRef: "goal" },
    { text: "可复现成果", kind: "state", sourceRef: "src-5" }] },
  // Only actions on record: the line is not left with nothing.
  media: { description: "", attributes: [{ text: "把焦虑讲得好笑", kind: "ability", sourceRef: "reply-3" }] }
};

function seed() {
  const store = new CrosslineStore(":memory:");
  store.setSetting(ws, "lines.profiles", JSON.stringify(profiles));
  store.setSetting(ws, "lines.v1", JSON.stringify([{ id: "research", label: "研究者", goalParts: ["神经形态计算", "把脑机制转化为计算机制与硬件结构"] }]));
  store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: "split", type: "line.candidates_split", entityId: "research",
    payload: { attributes: ["把脑机制转化为计算机制与硬件结构", "以真实技术链条和可复现证据工作"] } });
  return store;
}

test("model-proposed chips that are actions go, the person's adopted parts and a line's last chips stay, and it can be undone", () => {
  const store = seed();
  expect(repairLineAttributes(store, ws, owner)).toEqual({ research: ["外推知识边界", "以真实技术链条和可复现证据工作"] });
  const after = JSON.parse(store.getSetting(ws, "lines.profiles")!);
  expect(after.research.attributes.map((item: { text: string }) => item.text)).toEqual(["神经形态计算", "把脑机制转化为计算机制与硬件结构", "可复现成果"]);
  expect(after.media.attributes).toHaveLength(1);
  const op = store.listEvents(ws, { type: "op.applied" }).at(-1)!.payload as { inverse: { kind: string; entries: Array<{ key: string; value: string }> } };
  expect(op.inverse).toEqual({ kind: "settings.restore", entries: [{ key: "lines.profiles", value: JSON.stringify(profiles) }] });
  // Once only.
  expect(store.getSetting(ws, LINE_ATTRIBUTE_REPAIR)).toBeTruthy();
  expect(repairLineAttributes(store, ws, owner)).toBeUndefined();
  store.close();
});

test("a split of the person's own adopted goal is theirs and is kept whatever its wording", () => {
  const store = new CrosslineStore(":memory:");
  store.setSetting(ws, "lines.profiles", JSON.stringify({ research: { attributes: [
    { text: "神经形态计算", kind: "domain", sourceRef: "reply-1" }, { text: "以真实证据工作", kind: "ability", sourceRef: "goal" }] } }));
  expect(repairLineAttributes(store, ws, owner)).toEqual({});
  store.close();
});
