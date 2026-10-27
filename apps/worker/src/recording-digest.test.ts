import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { RECORDING_DIGESTED_EVENT, RECORDING_TRANSCRIBED_EVENT, autoApprovalEligible, validateRecordingDigest } from "@crossline/core";
import { CrosslineStore } from "@crossline/db";
import { createRecordingDigester, transcriptDocumentIds, transcriptsAwaitingDigest } from "./recording-digest";
import { fakeRuntime } from "./testing/fake-runtime";
import { withoutHallucinations } from "./transcribe";

let store: CrosslineStore;
let workspaceId: string;
let ownerId: string;
let data: string;

const meeting = "[录音：phone/a.m4a，约 2026-10-20 09:30 开始，时长 45:00]\n[语言：中文，自动识别]\n[00:20] 今天组会主要讨论开题报告的结构\n[05:10] 我周五之前把第二章的初稿发给王老师\n[06:00] 王老师说下周三下午三点在 2310 开会\n[07:30] 本人做电路仿真，用的是 Cadence";
const chat = "[录音：phone/b.m4a，约 2026-10-20 12:00 开始，时长 20:00]\n[00:01] 中午吃什么呀要不要去那家面馆今天人应该不多吧我们走过去好了天气不错";
const tiny = "[录音：phone/c.m4a，约 2026-10-20 13:00 开始，时长 30:00]\n[00:01] 嗯";

function transcript(id: string, text: string, seconds = 2700) {
  store.saveSourceDocument({ id, ownerId, workspaceId, kind: "text", fileName: `phone/${id}.m4a 转写.txt`, mediaType: "text/plain", sha256: `sha-${id}`,
    uri: `file:///nowhere/${id}.txt`, extractedText: text, extractionStatus: "done", createdAt: "2026-10-20T15:00:00Z" });
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: `t:${id}`, type: RECORDING_TRANSCRIBED_EVENT, entityId: `audio-${id}`,
    payload: { fileName: `${id}.m4a`, seconds, speechSeconds: 600, workMs: 1000, wallMs: 1000, documentId: id } });
}

beforeEach(() => {
  store = new CrosslineStore(":memory:");
  const created = store.createPrincipalWithWorkspace("user-1", "个人");
  workspaceId = created.workspace.id; ownerId = created.principal.id;
  data = mkdtempSync(path.join(tmpdir(), "crossline-digest-"));
  store.setSetting(workspaceId, "lines.v1", JSON.stringify([{ id: "research", label: "研究者", color: "research", goal: "", goals: [], createdAt: "2026-10-14" }]));
});
afterEach(() => { store.close(); rmSync(data, { recursive: true, force: true }); });

const answer = JSON.stringify({ recordings: [
  { id: "a", kind: "meeting", title: "组会：开题报告", summary: "讨论开题报告结构；本人周五前交第二章初稿；下周三开会。", lineIds: ["research", "nonexistent"], projectId: "",
    commitments: [{ text: "把第二章初稿发给王老师", by: "person", who: "", due: "2026-10-23", quote: "我周五之前把第二章的初稿发给王老师" },
      { text: "安排开会", by: "other", who: "王老师", due: "", quote: "王老师说下周三下午三点在 2310 开会" },
      { text: "编出来的承诺", by: "person", who: "", due: "", quote: "这句话录音里没有" }],
    facts: [{ identityId: "research", projectId: "", slot: "simulation_tool", value: "电路仿真用 Cadence", quote: "本人做电路仿真，用的是 Cadence" }],
    dates: [{ title: "组会", date: "2026-10-28", time: "15:00", quote: "下周三下午三点在 2310 开会" }] },
  { id: "b", kind: "small_talk", title: "午饭闲聊", summary: "不该留下", lineIds: [], projectId: "", commitments: [], facts: [], dates: [] }] });

test("kept recordings become a summary, inferred facts and captures that wait for the person; small talk and noise leave nothing", async () => {
  transcript("a", meeting); transcript("b", chat); transcript("c", tiny);
  const { rpc, turns } = fakeRuntime([answer], "crossline:crossline-recording-digest");
  const outcome = await createRecordingDigester(store, workspaceId, "C:\\repo", () => rpc, { dataDir: data, timeZone: "America/Chicago" })();
  expect(outcome).toEqual({ digested: 3, kept: 1, captures: 1, facts: 2, waits: 1 });
  expect(turns()).toBe(1);
  // The near-empty one was noise by rule, without the model.
  expect(store.listEvents(workspaceId, { type: RECORDING_DIGESTED_EVENT, entityId: "c" })[0]!.payload).toMatchObject({ kind: "noise", by: "rule" });
  const digest = store.listSourceDocuments(workspaceId).find((doc) => doc.fileName === "phone/a.m4a 摘要.md")!;
  expect(digest.extractedText).toContain("## 本人答应做的");
  expect(digest.extractedText).toContain("别人答应的或说不清是谁");
  expect(digest.extractedText).toContain("- 王老师：安排开会");
  expect(digest.extractedText).not.toContain("编出来的承诺");
  // What the other party promised is a wait on its day — no day named, so a week after the recording — that only the person closes.
  expect(store.listWaitingItems(workspaceId, { state: "open" })).toMatchObject([{ id: "wait-recording-a-0", title: "安排开会", who: "王老师", expectedAt: "2026-10-27",
    followUpAt: "2026-10-27", approximate: true, source: "recording", blocks: [] }]);
  expect(store.listSourceDocuments(workspaceId).some((doc) => doc.fileName.includes("b.m4a 摘要"))).toBe(false);
  const facts = store.listProfileFacts(workspaceId).filter((fact) => fact.sourceRef === "recording:a");
  expect(facts.map((fact) => [fact.slot.startsWith("date_heard_") ? "date" : fact.slot, fact.status])).toEqual(expect.arrayContaining([["simulation_tool", "inferred"], ["date", "inferred"]]));
  const [capture] = store.listCaptures(workspaceId);
  expect(capture).toMatchObject({ id: "recording-a-0", title: "把第二章初稿发给王老师" });
  expect(capture!.context).toContain("我周五之前把第二章的初稿发给王老师");
  // What was only heard never takes effect by itself.
  expect(autoApprovalEligible({ id: capture!.id, state: "awaiting_plan_approval", riskTier: "low", intent: "发初稿", payload: {} }).eligible).toBe(false);
  // The interview reads the digest, not the raw transcripts; nothing is digested twice.
  expect([...transcriptDocumentIds(store, workspaceId)].sort()).toEqual(["a", "b", "c"]);
  expect(transcriptsAwaitingDigest(store, workspaceId)).toEqual([]);
});

test("a digest that leaves out a recording is sent back; items quoting text that is not there are dropped", () => {
  const transcripts = new Map([["a", meeting], ["b", chat]]);
  expect(() => validateRecordingDigest({ recordings: [JSON.parse(answer).recordings[0]] }, { transcripts, lineIds: ["research"], projectIds: [] })).toThrow(/RECORDING_DIGEST_MISSING/);
  const kept = validateRecordingDigest(JSON.parse(answer), { transcripts, lineIds: ["research"], projectIds: [] });
  expect(kept.recordings[0]!.commitments.map((item) => item.text)).toEqual(["把第二章初稿发给王老师", "安排开会"]);
  expect(kept.recordings[0]!.lineIds).toEqual(["research"]);
  expect(kept.recordings[1]).toMatchObject({ kind: "small_talk", summary: "", commitments: [] });
});

test("subtitle stock phrases and a looping line are not kept in a transcript", () => {
  const chunk = (text: string) => ({ start: 0, end: 1, text });
  expect(withoutHallucinations([chunk("谢谢观看！"), chunk("请不吝点赞 订阅 转发 打赏支持明镜与点点栏目"), chunk("我们开始吧"),
    chunk("好"), chunk("好"), chunk("好"), chunk("Thank you for watching.")]).map((item) => item.text)).toEqual(["我们开始吧", "好", "好"]);
});

test("with the person's lines marked, a promise is theirs only when a 本人 line says it", () => {
  const diarized = "[录音：phone/c.m4a，约 2026-10-20 15:00 开始，时长 10:00]\n[00:05] 本人：我明天把实验数据整理好发给你\n[00:12] 说话人 1：好的我周五之前把评审意见给你\n[00:20] 说话人 2：我来订会议室";
  const item = (by: "person" | "other" | "unclear", quote: string) => ({ text: quote.slice(0, 10), by, who: "", due: "", quote });
  const answer = { recordings: [{ id: "c", kind: "meeting", title: "讨论", summary: "讨论了数据与评审", lineIds: [], projectId: "",
    commitments: [item("unclear", "我明天把实验数据整理好发给你"), item("other", "我周五之前把评审意见给你"), item("person", "我来订会议室")], facts: [], dates: [] }] };
  const kept = validateRecordingDigest(answer, { transcripts: new Map([["c", diarized]]), lineIds: [], projectIds: [] });
  expect(kept.recordings[0]!.commitments.map((c) => c.by)).toEqual(["person", "other", "unclear"]);
  // Without any 本人 line (no voiceprint), the model's reading stands.
  const plain = diarized.replace("本人：", "说话人 3：");
  expect(validateRecordingDigest(answer, { transcripts: new Map([["c", plain]]), lineIds: [], projectIds: [] }).recordings[0]!.commitments.map((c) => c.by)).toEqual(["unclear", "other", "person"]);
});
