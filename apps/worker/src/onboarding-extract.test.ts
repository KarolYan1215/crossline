import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore, extractBacklog, readExtractState, writeExtractState } from "@crossline/db";
import { createOnboardingSessionRunner, ONBOARDING_SKILL } from "./onboarding-session";
import { createOnboardingExtractor, evidenceTools, extractionSettled, ONBOARDING_EXTRACT_SKILL, requestExtraction, searchTerms } from "./onboarding-extract";
import { fakeRuntime } from "./testing/fake-runtime";

const EXTRACT = "crossline.onboarding.extract.v1";
let store: CrosslineStore;
let workspaceId: string;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  workspaceId = store.createPrincipalWithWorkspace("user-1", "个人 workspace").workspace.id;
});
afterEach(() => store.close());

const round = JSON.stringify({ reply: "收到。", questions: [{ id: "q1", text: "还有别的项目吗？", kind: "free", options: [], allowOther: true, identityId: "", projectId: "", repeats: 0 }],
  coverage: [], nextAction: "ask", stage: "orientation" });
const facts = (over: object = {}) => JSON.stringify({ slotUpdates: [], projectsDetected: [], flywheelCandidates: [], lineProfiles: [], goalEdits: [],
  fileDates: { dates: [], recurring: [], questions: [], undated: [] }, availability: { windows: [], why: "" }, profile: null, ...over });
const deadline = (refs: number[]) => facts({ slotUpdates: [{ identityId: "research", projectId: "", slot: "deadline", value: "12 月中", status: "confirmed", refs }] });
const runtime = (dialogue: string[], extract: string[], options: { delayMs?: number } = {}) =>
  fakeRuntime(dialogue, [ONBOARDING_SKILL, ONBOARDING_EXTRACT_SKILL], { routes: [{ match: EXTRACT, answers: extract }], ...options });

test("in the app the round reaches the person without waiting for the extraction, which records the facts afterwards", async () => {
  const { rpc } = runtime([round], [deadline([1])]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  expect(await run({ sessionId: "s", text: "论文 12 月中投稿。" })).toEqual({ state: "asked", sessionId: "s" });
  await extractionSettled(workspaceId);
  expect(store.listProfileFacts(workspaceId).find((fact) => fact.slot === "deadline")).toMatchObject({ sourceQuote: "论文 12 月中投稿。", sourceSentences: [1] });
  expect(readExtractState(store, workspaceId, "s")).toMatchObject({ upTo: 1, failures: 0 });
  expect(extractBacklog(store, workspaceId, "s")).toEqual({ replies: 0, files: 0 });
});

test("a failed extraction backs off, says so, and is taken up again once its wait is over; the conversation is not held", async () => {
  const { rpc } = runtime([round], ["not json", "not json", "not json", deadline([1])]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { extract: "await" });
  expect((await run({ sessionId: "s", text: "论文 12 月中投稿。" })).state).toBe("asked");
  const failed = readExtractState(store, workspaceId, "s");
  expect(failed).toMatchObject({ upTo: 0, failures: 1, lastError: { code: "SKILL_SCHEMA_INVALID" } });
  expect(Date.parse(failed.retryAt!) - Date.now()).toBeGreaterThan(50_000);
  expect(extractBacklog(store, workspaceId, "s")).toMatchObject({ replies: 1, failing: { code: "SKILL_SCHEMA_INVALID" } });
  // The worker's tick leaves it while it waits, and takes it up once the wait is over.
  const extractor = createOnboardingExtractor(store, workspaceId, "C:\\repo", () => rpc);
  expect(extractor.nextSession()).toBeUndefined();
  writeExtractState(store, workspaceId, "s", { ...failed, retryAt: new Date(Date.now() - 1000).toISOString() });
  expect(extractor.nextSession()).toBe("s");
  await requestExtraction(workspaceId, () => extractor.runOnce());
  expect(readExtractState(store, workspaceId, "s")).toMatchObject({ upTo: 1, failures: 0 });
  expect(store.listProfileFacts(workspaceId).map((fact) => fact.slot)).toEqual(["deadline"]);
});

test("files over one run's budget wait for the next run, which follows at once", async () => {
  for (let index = 1; index <= 14; index += 1) store.saveSourceDocument({ id: `d${index}`, ownerId: "o", workspaceId, kind: "text", fileName: `f${index}.txt`,
    mediaType: "text/plain", sha256: `s${index}`, uri: `file:///${index}`, extractedText: `第 ${index} 份材料的内容。`, extractionStatus: "done", createdAt: "2026-10-02T00:00:00.000Z" });
  const { rpc, prompts } = runtime([round], [facts()]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { extract: "await" });
  await run({ sessionId: "s", text: "材料都传了" });
  // The dialogue showed twelve; the extraction read those twelve, then (the next turn having queued none) nothing more waits.
  const extractions = prompts().filter((prompt) => prompt.includes(EXTRACT));
  expect(extractions).toHaveLength(1);
  expect((extractions[0]!.match(/"fileName"/g) ?? []).length).toBe(12);
  expect(extractBacklog(store, workspaceId, "s").files).toBe(0);
  // The next turn shows the last two to the dialogue, and they are extracted then.
  await run({ sessionId: "s", text: "继续" });
  const second = prompts().filter((prompt) => prompt.includes(EXTRACT))[1]!;
  expect((second.match(/"fileName"/g) ?? []).length).toBe(2);
});

test("the lookups find an earlier sentence by its words or its number, and whatever they return may be cited", () => {
  expect(searchTerms("组会 Tuesday 9.00")).toEqual(expect.arrayContaining(["组会", "tuesday", "9", "00"]));
  const corpus = [
    { id: 1, sourceKind: "reply" as const, sourceId: "s#1", ord: 0, start: 0, end: 9, text: "每周二上午组会。", retired: false, ref: "reply-1", label: "reply-1" },
    { id: 2, sourceKind: "reply" as const, sourceId: "s#1", ord: 1, start: 9, end: 20, text: "论文 12 月中投稿。", retired: false, ref: "reply-1", label: "reply-1" },
    { id: 3, sourceKind: "document" as const, sourceId: "d1", ord: 0, start: 0, end: 18, text: "Week-8: 27th Oct.", retired: false, ref: "src-1", label: "src-1 · plan.txt" }];
  const cited: number[] = [];
  const tools = evidenceTools(() => corpus, (found) => cited.push(...found.map((item) => item.id)));
  expect(tools.call("search_evidence", { query: "组会在周几" })).toBe("[1] (reply-1) 每周二上午组会。");
  expect(tools.call("read_sentences", { ids: [1], around: 1 })).toBe("[1] (reply-1) 每周二上午组会。\n[2] (reply-1) 论文 12 月中投稿。");
  // A neighbour in another source is not this sentence's context.
  expect(tools.call("read_sentences", { ids: [2], around: 1 })).not.toContain("Week-8");
  expect(tools.call("search_evidence", { query: "oct" })).toContain("[3] (src-1 · plan.txt)");
  expect([...new Set(cited)].sort()).toEqual([1, 2, 3]);
});

test("a line's own interview extracts its replies only, never the files, and does not rewrite the portrait", async () => {
  store.saveSourceDocument({ id: "d1", ownerId: "o", workspaceId, kind: "text", fileName: "plan.txt", mediaType: "text/plain", sha256: "x", uri: "file:///x",
    extractedText: "Week-8: 27th Oct.", extractionStatus: "done", createdAt: "2026-10-02T00:00:00.000Z" });
  store.setSetting(workspaceId, "profile.model", JSON.stringify({ portrait: "原画像" }));
  const { rpc, prompts } = runtime([round], [facts({ profile: { portrait: "不应写入" } })]);
  await createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { extract: "await" })({ sessionId: "line-research", text: "补充一点" });
  const extraction = prompts().find((prompt) => prompt.includes(EXTRACT))!;
  expect(extraction).not.toContain("plan.txt");
  expect(extraction).toContain('"profile":null');
  expect(JSON.parse(store.getSetting(workspaceId, "profile.model")!)).toMatchObject({ portrait: "原画像" });
});
