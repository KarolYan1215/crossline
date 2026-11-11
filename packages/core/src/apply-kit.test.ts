import { expect, test } from "vitest";
import { KIT_ANSWERS_MAX, editKit, emptyKit, kitDrafts, previewFields, readApplyKit, type ApplyKit, type KitEdit } from "./apply-kit";
import type { ProfileItem } from "./form-fill";

let n = 0;
const opts = { at: "2026-11-10T00:00:00.000Z", newId: () => `k${++n}`, change: (edit: KitEdit, title: string) => `${edit.op}:${title}` };

test("every edit is a new version with a history line; an edit that changes nothing is not", () => {
  let kit = emptyKit();
  const first = editKit(kit, { op: "answer", prompt: "为什么想参加", text: "想把类脑硬件做成产品原型。" }, opts);
  expect(first).toMatchObject({ changed: true, kit: { version: 1, history: [{ version: 1, change: "answer:为什么想参加" }] } });
  kit = first.kit;
  expect(editKit(kit, { op: "answer", id: first.id, prompt: "为什么想参加", text: "想把类脑硬件做成产品原型。" }, opts).changed).toBe(false);
  kit = editKit(kit, { op: "document", kind: "resume", label: "2026 秋简历", path: "C:\\docs\\cv.pdf" }, opts).kit;
  kit = editKit(kit, { op: "answer", id: first.id, prompt: "为什么想参加", text: "改过的回答" }, opts).kit;
  expect(kit.version).toBe(3);
  expect(kit.answers).toEqual([expect.objectContaining({ id: first.id, text: "改过的回答" })]);
  expect(editKit(kit, { op: "answer", prompt: "", text: "x" }, opts).changed).toBe(false);
  expect(readApplyKit(JSON.stringify(kit))).toEqual(kit);
  expect(readApplyKit("not json")).toEqual(emptyKit());
});

test("the kit is capped and its answers become drafts naming the version", () => {
  let kit: ApplyKit = emptyKit();
  for (let index = 0; index < KIT_ANSWERS_MAX + 2; index += 1) kit = editKit(kit, { op: "answer", prompt: `q${index}`, text: `a${index}` }, opts).kit;
  expect(kit.answers).toHaveLength(KIT_ANSWERS_MAX);
  const drafts = kitDrafts(kit, 2);
  expect(Object.keys(drafts)).toHaveLength(2);
  expect(Object.values(drafts)[0]).toEqual({ text: "a0", version: `kit v${KIT_ANSWERS_MAX} · q0` });
});

test("preview: name and email always, items the materials and terms name, documents and short answers from the kit, consents; sensitive never shown", () => {
  const profile: ProfileItem[] = [
    { slot: "full_name", sensitive: false, present: true, value: "Qiao Lin" }, { slot: "email", sensitive: false, present: true, value: "qiao@example.edu" },
    { slot: "school", sensitive: false, present: false }, { slot: "phone", sensitive: true, present: true }, { slot: "student_id", sensitive: true, present: false }];
  let kit = editKit(emptyKit(), { op: "answer", prompt: "Why do you want to attend?", text: "To meet neuromorphic hardware people." }, opts).kit;
  kit = editKit(kit, { op: "document", kind: "resume", label: "CV", path: "C:\\cv.pdf" }, opts).kit;
  const rows = previewFields({ materials: ["Resume (PDF)", "Phone number", "Student ID", "Short answer: why do you want to attend", "Transcript"],
    consents: ["I agree to the code of conduct"], eligibility: [{ dim: "school", rule: "UW students", quote: "Open to UW students" }] }, profile, kit);
  const by = Object.fromEntries(rows.map((row) => [row.key, row]));
  expect(by["slot:full_name"]).toMatchObject({ state: "ready", value: "Qiao Lin", why: "always" });
  expect(by["slot:school"]).toMatchObject({ state: "missing", why: "eligibility" });
  expect(by["slot:phone"]).toMatchObject({ state: "held" });
  expect(by["slot:phone"]?.value).toBeUndefined();
  expect(by["slot:student_id"]).toMatchObject({ state: "missing" });
  expect(by["doc:Resume (PDF)"]).toMatchObject({ state: "ready", value: "CV" });
  expect(by["doc:Transcript"]).toMatchObject({ state: "missing" });
  expect(by["answer:Short answer: why do you want to attend"]).toMatchObject({ state: "ready", value: "To meet neuromorphic hardware people." });
  expect(rows.at(-1)).toMatchObject({ source: "consent", label: "I agree to the code of conduct" });
});
