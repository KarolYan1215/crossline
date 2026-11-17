import { afterEach, beforeEach, expect, test } from "vitest";
import { ONBOARDING_INSIGHTS } from "@crossline/core";
import { CrosslineStore, extractBacklog, readExtractState, writeExtractState } from "@crossline/db";
import { createOnboardingSessionRunner as createRunner, ONBOARDING_SKILL } from "./onboarding-session";
import { createOnboardingExtractor, evidenceTools, extractionSettled, ONBOARDING_EXTRACT_SKILL, readLaneState, requestExtraction, searchTerms } from "./onboarding-extract";
import { fakeRuntime } from "./testing/fake-runtime";

const EXTRACT = "crossline.onboarding.extract.v1";
// One run writes everything here, as the answer queues below are written for; the lanes have tests of their own (`lanes: true`).
const createOnboardingSessionRunner = (...args: Parameters<typeof createRunner>) =>
  createRunner(args[0], args[1], args[2], args[3], { lanes: false, ...(args[4] ?? {}) });
let store: CrosslineStore;
let workspaceId: string;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  workspaceId = store.createPrincipalWithWorkspace("user-1", "个人 workspace").workspace.id;
});
afterEach(() => { store.close(); delete process.env.CROSSLINE_PORTRAIT_BATCH; });

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
  expect(extractBacklog(store, workspaceId, "s")).toEqual({ replies: 0, frontReplies: 0, files: 0 });
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

test("goal attributes that are actions or achievements are dropped: a line with none on record keeps the real ones, a fuller one keeps its own", async () => {
  const onRecord = ["科普", "有趣", "稳定更新", "值得信赖"].map((text) => ({ text, kind: "state", sourceRef: "reply-0" }));
  store.setSetting(workspaceId, "lines.profiles", JSON.stringify({ media: { description: "小红书科普", attributes: onRecord } }));
  const attribute = (text: string) => ({ text, kind: "ability", refs: [1] });
  const answer = facts({ lineProfiles: [
    { lineId: "research", description: "做忆阻器研究", attributeCandidates: [attribute("严谨"), attribute("能独立立项"), attribute("发表三篇顶会论文"), attribute("独立")] },
    { lineId: "media", description: "", attributeCandidates: [attribute("有影响力"), attribute("写公众号长文")] }] });
  const { rpc, prompts } = runtime([round], [answer]);
  await createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { extract: "await" })({ sessionId: "s", text: "希望自己严谨、独立，三年内发三篇顶会。" });
  // The model was told what was wrong and how to write an attribute before its answer was kept.
  expect(prompts().filter((prompt) => prompt.includes("ONBOARDING_ATTRIBUTE_NOT_DESCRIPTIVE")).length).toBeGreaterThan(0);
  const profiles = JSON.parse(store.getSetting(workspaceId, "lines.profiles")!) as Record<string, { attributes: Array<{ text: string }> }>;
  expect(profiles.research!.attributes.map((item) => item.text)).toEqual(["严谨", "独立"]);
  expect(profiles.media!.attributes.map((item) => item.text)).toEqual(["科普", "有趣", "稳定更新", "值得信赖"]);
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

test("a file longer than one run reads is read on in the next runs, never marked done after its first part (W-228)", async () => {
  const body = Array.from({ length: 700 }, (_, index) => `Week ${index}: reading and practice for the course.`).join("\n");
  store.saveSourceDocument({ id: "d1", ownerId: "o", workspaceId, kind: "text", fileName: "syllabus.txt", mediaType: "text/plain", sha256: "s", uri: "file:///s",
    extractedText: `${body}\nFINAL EXAM 12/10 in class`, extractionStatus: "done", createdAt: "2026-10-02T00:00:00.000Z" });
  const { rpc, prompts } = runtime([round, round], [facts(), facts(), facts(), facts()]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { extract: "await" });
  await run({ sessionId: "s", text: "课程大纲传了" });
  await extractionSettled(workspaceId);
  const extractions = () => prompts().filter((prompt) => prompt.includes(EXTRACT));
  expect(extractions()[0]).not.toContain("FINAL EXAM");
  for (let guard = 0; guard < 4 && !extractions().some((prompt) => prompt.includes("FINAL EXAM")); guard += 1) {
    await requestExtraction(workspaceId, (preferred) => createOnboardingExtractor(store, workspaceId, "C:\\repo", () => rpc).runOnce(preferred), "s");
    await extractionSettled(workspaceId);
  }
  expect(extractions().some((prompt) => prompt.includes("FINAL EXAM"))).toBe(true);
  expect(extractBacklog(store, workspaceId, "s").files).toBe(0);
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

test("a line's own interview extracts its replies only (its files go with the main interview), and does not rewrite the portrait", async () => {
  const now = "2026-10-19T00:00:00.000Z";
  store.saveOnboardingSession({ id: "main", ownerId: store.getWorkspaceOwnerId(workspaceId)!, workspaceId, state: "complete", coverage: {}, createdAt: now, updatedAt: now });
  store.saveSourceDocument({ id: "d1", ownerId: "o", workspaceId, kind: "text", fileName: "plan.txt", mediaType: "text/plain", sha256: "x", uri: "file:///x",
    extractedText: "Week-8: 27th Oct.", extractionStatus: "done", createdAt: "2026-10-02T00:00:00.000Z" });
  store.setSetting(workspaceId, "profile.model", JSON.stringify({ portrait: "原画像" }));
  const { rpc, prompts } = runtime([round], [facts({ profile: { portrait: "不应写入" } })]);
  await createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { extract: "await" })({ sessionId: "line-research", text: "补充一点" });
  const extractions = prompts().filter((prompt) => prompt.includes(EXTRACT));
  expect(extractions[0]).not.toContain("plan.txt");
  expect(extractions[0]).toContain('"profile":null');
  // The file the line's turn showed is extracted all the same, with the main interview.
  expect(extractions.some((prompt) => prompt.includes("plan.txt"))).toBe(true);
  expect(JSON.parse(store.getSetting(workspaceId, "profile.model")!)).toMatchObject({ portrait: "原画像" });
});

test("the portrait is kept by section: a deep section while its stage runs, finalized once the stage is over, the synthesis only after all three", async () => {
  const { portraitTask } = await import("./onboarding-extract");
  expect(portraitTask("situation", false, {})).toEqual({ finalize: [], synthesize: false });
  expect(portraitTask("compass", false, {})).toEqual({ finalize: ["situation"], synthesize: false });
  const done = { final: true, sentences: [1], at: "x" };
  expect(portraitTask("details", false, { situation: done })).toEqual({ finalize: ["compass", "energy"], synthesize: true });
  expect(portraitTask("details", false, { situation: done, compass: done, energy: done, synthesis: done }))
    .toEqual({ finalize: [], synthesize: false });
  // A section closed with nothing in it (the old rule) is asked again; one that came back empty twice stays closed.
  expect(portraitTask("details", false, { situation: { final: true, sentences: [], at: "x" }, compass: done, energy: done, synthesis: done }))
    .toEqual({ finalize: ["situation"], synthesize: true });
  expect(portraitTask("details", false, { situation: { final: true, sentences: [], at: "x", emptyRuns: 2 }, compass: done, energy: done, synthesis: done }))
    .toEqual({ finalize: [], synthesize: false });
  // A finished interview finalizes whatever is left, even a stage it skipped.
  expect(portraitTask("energy", true, {})).toEqual({ finalize: ["situation", "compass", "energy"], synthesize: true });
  // The profile-first flow: the life story comes first and is a section of its own; the synthesis waits for it too.
  expect(portraitTask("compass", false, {}, "v2")).toEqual({ finalize: ["narrative"], synthesize: false });
  expect(portraitTask("orientation", false, { narrative: done, compass: done }, "v2")).toEqual({ finalize: ["situation", "energy"], synthesize: true });
  expect(portraitTask("details", false, { situation: done, compass: done, energy: done })).toEqual({ finalize: [], synthesize: true });

  const now = "2026-10-19T00:00:00.000Z";
  const ownerId = store.getWorkspaceOwnerId(workspaceId)!;
  store.saveOnboardingSession({ id: "s", ownerId, workspaceId, state: "active", coverage: { stage: "situation", flow: "v1" }, createdAt: now, updatedAt: now });
  store.setSetting(workspaceId, "profile.model", JSON.stringify({ portrait: "旧的一句话", workView: "旧工作观" }));
  const sections = (over: object) => facts({ profileSections: { situation: null, compass: null, energy: null, synthesis: null, ...over } });
  const { rpc, prompts } = runtime([round], [
    sections({ situation: { problem: "论文和产品抢同一段时间", gravity: [], designable: [], reframes: [], refs: [1] },
      synthesis: { portrait: "不该现在写", coreConflict: "", allocation: "", refs: [] } }),
    sections({ situation: { problem: "论文投稿前，产品只做维护", gravity: ["导师的时间表"], designable: [], reframes: [], refs: [2] } })]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc, { extract: "await" });
  await run({ sessionId: "s", text: "论文和产品在抢同一段时间。" });
  const first = JSON.parse(store.getSetting(workspaceId, "profile.model")!) as Record<string, unknown>;
  // The situation section is written with its sentences; the synthesis waits; the compass is untouched.
  expect(first).toMatchObject({ problem: "论文和产品抢同一段时间", portrait: "旧的一句话", workView: "旧工作观" });
  expect(JSON.parse(store.getSetting(workspaceId, "profile.sections")!)).toMatchObject({ situation: { sentences: [1], final: false } });
  // The conversation moved on to the compass: the next run rewrites the situation whole and marks it final.
  const session = store.getOnboardingSession(workspaceId, "s")!;
  store.saveOnboardingSession({ ...session, coverage: { ...session.coverage, stage: "compass" } });
  await run({ sessionId: "s", text: "投稿前产品只做维护。" });
  const second = prompts().filter((prompt) => prompt.includes(EXTRACT))[1]!;
  const task = JSON.parse(second.slice(second.indexOf("{"), second.lastIndexOf("}") + 1)) as { profileTask: unknown };
  expect(task.profileTask).toEqual({ finalize: ["situation"], synthesize: false });
  expect(JSON.parse(store.getSetting(workspaceId, "profile.sections")!)).toMatchObject({ situation: { final: true } });
});

test("conversations from before the extraction start at their last reply; one the extraction has worked in is never backfilled", async () => {
  const { backfillExtractWatermarks } = await import("@crossline/db");
  const now = "2026-10-18T00:00:00.000Z";
  const ownerId = store.getWorkspaceOwnerId(workspaceId)!;
  store.saveOnboardingSession({ id: "old", ownerId, workspaceId, state: "complete", coverage: {}, createdAt: now, updatedAt: now });
  for (const text of ["一", "二"]) store.appendOnboardingMessage({ sessionId: "old", workspaceId, role: "user", content: { text }, createdAt: now });
  expect(extractBacklog(store, workspaceId, "old").replies).toBe(2);
  expect(backfillExtractWatermarks(store, workspaceId)).toBe(1);
  expect(readExtractState(store, workspaceId, "old")).toMatchObject({ upTo: 2 });
  expect(createOnboardingExtractor(store, workspaceId, "C:\\repo", () => undefined).nextSession()).toBeUndefined();
  // Once only: a reply that waits after this is the extraction's to read.
  store.appendOnboardingMessage({ sessionId: "old", workspaceId, role: "user", content: { text: "三" }, createdAt: now });
  expect(backfillExtractWatermarks(store, workspaceId)).toBe(0);
  expect(extractBacklog(store, workspaceId, "old").replies).toBe(1);
});

test("a reply sent while another extraction runs is read in the next round even when its conversation is backing off", async () => {
  const now = "2026-10-19T00:00:00.000Z";
  const ownerId = store.getWorkspaceOwnerId(workspaceId)!;
  for (const id of ["a", "b"]) {
    store.saveOnboardingSession({ id, ownerId, workspaceId, state: "active", coverage: {}, createdAt: now, updatedAt: now });
    store.appendOnboardingMessage({ sessionId: id, workspaceId, role: "user", content: { text: `会话 ${id} 的回答。` }, createdAt: now });
  }
  // b failed a minute ago and waits half an hour.
  writeExtractState(store, workspaceId, "b", { upTo: 0, failures: 3, retryAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    lastError: { code: "X", message: "x", at: new Date(Date.now() - 60_000).toISOString() } });
  const { rpc } = runtime([round], [facts()], { delayMs: 20 });
  const extractor = createOnboardingExtractor(store, workspaceId, "C:\\repo", () => rpc);
  const first = requestExtraction(workspaceId, (preferred) => extractor.runOnce(preferred));
  // The person replies in b while a's run is in flight.
  const second = requestExtraction(workspaceId, (preferred) => extractor.runOnce(preferred), "b");
  expect(second).toBe(first);
  await first;
  expect(readExtractState(store, workspaceId, "a").upTo).toBe(1);
  expect(readExtractState(store, workspaceId, "b")).toMatchObject({ upTo: 1, failures: 0 });
});

test("a section owed but answered empty stays open, and is closed as it stands only after two empty runs", async () => {
  const { persistExtraction } = await import("./onboarding-persist");
  const ownerId = store.getWorkspaceOwnerId(workspaceId)!;
  const empty = { slotUpdates: [], projectsDetected: [], flywheelCandidates: [], profileSections: { situation: null, compass: null, energy: null, synthesis: null } };
  const task = { finalize: ["situation" as const], synthesize: false };
  const sections = () => JSON.parse(store.getSetting(workspaceId, "profile.sections") ?? "{}") as Record<string, { final: boolean; emptyRuns?: number }>;
  persistExtraction(store, workspaceId, empty as never, { sessionId: "s", ownerId, documentIds: [], sources: {}, today: "2026-10-19", reread: false, profileTask: task });
  expect(sections().situation).toMatchObject({ final: false, emptyRuns: 1 });
  persistExtraction(store, workspaceId, empty as never, { sessionId: "s", ownerId, documentIds: [], sources: {}, today: "2026-10-19", reread: false, profileTask: task });
  expect(sections().situation).toMatchObject({ final: true, emptyRuns: 2 });
});

test("only replies to the opening and the front stages hold the start; a deep-stage answer waiting does not", () => {
  const now = "2026-10-19T00:00:00.000Z";
  store.appendOnboardingMessage({ sessionId: "s", workspaceId, role: "user", content: { text: "开场" }, createdAt: now });
  store.appendOnboardingMessage({ sessionId: "s", workspaceId, role: "assistant", content: { reply: "", questions: [], stage: "lines" }, createdAt: now });
  store.appendOnboardingMessage({ sessionId: "s", workspaceId, role: "user", content: { text: "主线的回答" }, createdAt: now });
  store.appendOnboardingMessage({ sessionId: "s", workspaceId, role: "assistant", content: { reply: "", questions: [], stage: "situation" }, createdAt: now });
  store.appendOnboardingMessage({ sessionId: "s", workspaceId, role: "user", content: { text: "处境的回答" }, createdAt: now });
  expect(extractBacklog(store, workspaceId, "s")).toMatchObject({ replies: 3, frontReplies: 2 });
  writeExtractState(store, workspaceId, "s", { upTo: 3, failures: 0 });
  expect(extractBacklog(store, workspaceId, "s")).toMatchObject({ replies: 1, frontReplies: 0 });
});

test("an interview the dialogue ended owes a run until the synthesis is written, at most twice, and that run finalizes every deep section", async () => {
  const { markFinishing, FINISH_RUNS_MAX } = await import("@crossline/db");
  const { prompts, rpc } = runtime([round], [facts(), facts()]);
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => rpc);
  await run({ sessionId: "s", text: "能量部分答完了。" });
  await extractionSettled(workspaceId);
  const extractor = createOnboardingExtractor(store, workspaceId, "C:\\repo", () => rpc);
  expect(extractor.nextSession()).toBeUndefined();
  markFinishing(store, workspaceId, "s");
  expect(extractor.nextSession()).toBe("s");
  expect(await extractor.runOnce()).toMatchObject({ state: "done", replies: 0 });
  // The run made for it asked for every deep section and the synthesis, though the stage never moved past energy.
  const last = prompts().filter((prompt) => prompt.includes(EXTRACT)).at(-1)!;
  expect(last).toMatch(/"finalize":\[[^\]]*"energy"/);
  expect(last).toContain('"synthesize":true');
  markFinishing(store, workspaceId, "s", FINISH_RUNS_MAX);
  expect(extractor.nextSession()).toBeUndefined();
});

test("the extraction is shown the hours on record, so sending them again keeps what the new reply does not change", async () => {
  store.setSetting(workspaceId, "schedule.availability.proposed", JSON.stringify({ windows: [{ days: [0, 6], start: "10:00", end: "18:00", energy: "medium" }], why: "" }));
  const { rpc, prompts } = runtime([round], [facts()]);
  await createOnboardingSessionRunner(store, workspaceId, "C:\repo", () => rpc, { extract: "await" })({ sessionId: "s", text: "工作日 0 点睡 7 点半起。" });
  const extraction = prompts().find((prompt) => prompt.includes(EXTRACT))!;
  expect(extraction).toContain('"hours":[{"days":[0,6],"startMinute":600,"endMinute":1080,"energy":"medium"}]');
});

test("words the person wrote elsewhere are read as notes: facts with their sentence, never the portrait, never the files, nor the latest interview", async () => {
  const { NOTES_SESSION, recordPersonNote, backfillExtractWatermarks } = await import("@crossline/db");
  const ownerId = store.getWorkspaceOwnerId(workspaceId)!;
  const now = "2026-11-03T00:00:00.000Z";
  store.saveOnboardingSession({ id: "main", ownerId, workspaceId, state: "complete", coverage: {}, createdAt: now, updatedAt: now });
  writeExtractState(store, workspaceId, "main", { upTo: 0, failures: 0 });
  store.setSetting(workspaceId, "profile.model", JSON.stringify({ portrait: "原画像" }));
  const note = { text: "每周二上午十点和 Prof Lin 开组会。", source: { kind: "ask" as const, id: "wait:w1:1" }, about: "待决：「测量数据」到了吗？" };
  expect(recordPersonNote(store, workspaceId, ownerId, { ...note, text: "好的" }, now)).toBe(false);
  expect(recordPersonNote(store, workspaceId, ownerId, { ...note, text: "这个什么时候到？" }, now)).toBe(false);
  expect(recordPersonNote(store, workspaceId, ownerId, note, now)).toBe(true);
  expect(recordPersonNote(store, workspaceId, ownerId, note, now)).toBe(false);
  // Not the interview the app shows, and a restart's backfill never skips a note still waiting.
  expect(store.getLatestOnboardingSession(workspaceId)?.id).toBe("main");
  expect(backfillExtractWatermarks(store, workspaceId)).toBe(0);
  const extractor = createOnboardingExtractor(store, workspaceId, "C:\repo", () => rpc);
  const answer = facts({ slotUpdates: [{ identityId: "research", projectId: "", slot: "group_meeting", value: "每周二 10:00，与 Prof Lin", status: "confirmed", refs: [1] }],
    profile: { portrait: "不应写入" } });
  const { rpc, prompts } = runtime([], [answer]);
  expect(extractor.nextSession()).toBe(NOTES_SESSION);
  expect(await extractor.runOnce()).toMatchObject({ state: "done", sessionId: NOTES_SESSION, replies: 1 });
  const prompt = prompts().find((item) => item.includes(EXTRACT))!;
  expect(prompt).toContain("待决：「测量数据」到了吗？");
  expect(prompt).toContain('"profile":null');
  expect(store.listProfileFacts(workspaceId).find((fact) => fact.slot === "group_meeting")).toMatchObject({ status: "confirmed", sourceQuote: note.text });
  expect(JSON.parse(store.getSetting(workspaceId, "profile.model")!)).toMatchObject({ portrait: "原画像" });
  expect(extractor.nextSession()).toBeUndefined();
});

test("in lanes the ledger, the portrait's sections and its inferences are written by three runs side by side, each with its own fields and watermark", async () => {
  // One reply, read by every lane at once: the portrait's batching is tested on its own.
  process.env.CROSSLINE_PORTRAIT_BATCH = "1";
  const now = "2026-11-12T00:00:00.000Z";
  const ownerId = store.getWorkspaceOwnerId(workspaceId)!;
  store.saveOnboardingSession({ id: "s", ownerId, workspaceId, state: "active", coverage: { stage: "situation", flow: "v1" }, createdAt: now, updatedAt: now });
  const sections = facts({ profileSections: { situation: { problem: "论文和产品抢同一段时间", gravity: [], designable: [], reframes: [], refs: [1] },
    compass: null, energy: null, synthesis: null } });
  const { rpc, prompts } = fakeRuntime([round], [ONBOARDING_SKILL, ONBOARDING_EXTRACT_SKILL], { routes: [
    { match: '"lane":"sections"', answers: [sections] },
    { match: '"lane":"insights"', answers: [JSON.stringify({ hypotheses: [], careers: [], dimensions: [], dropCareers: [] })] },
    { match: EXTRACT, answers: [deadline([1])] }] });
  // The person's ratings of this session's cards, in full and with the correction (another session's are not this one's).
  store.setSetting(workspaceId, ONBOARDING_INSIGHTS, JSON.stringify({
    "s#2.1": { verdict: "partial", text: "你最投入的两次都有人等着结果。", correction: "等结果的是我自己定的期限", at: "2026-11-12T00:00:01.000Z" },
    "s#2": { verdict: "fits", text: "你先搭框架再动手。", at: "2026-11-12T00:00:00.500Z" },
    "t#2": { verdict: "off", text: "别的会话的卡。", at: "2026-11-12T00:00:02.000Z" } }));
  const run = createRunner(store, workspaceId, "C:\\repo", () => rpc);
  expect((await run({ sessionId: "s", text: "论文 12 月中投稿，和产品在抢同一段时间。" })).state).toBe("asked");
  await extractionSettled(workspaceId);
  const runs = prompts().filter((prompt) => prompt.includes(EXTRACT));
  expect(runs).toHaveLength(3);
  const contextOf = (lane: string) => { const prompt = runs.find((item) => item.includes(`"lane":"${lane}"`))!;
    return JSON.parse(prompt.slice(prompt.indexOf("{"), prompt.lastIndexOf("}") + 1)) as { profile: unknown; profileTask: unknown }; };
  // The ledger lane records facts without the portrait in its context; the sections' lane owes the portrait, the inferences' reads it.
  const ledger = runs.find((item) => !item.includes('"lane":"sections"') && !item.includes('"lane":"insights"'))!;
  expect(JSON.parse(ledger.slice(ledger.indexOf("{"), ledger.lastIndexOf("}") + 1))).toMatchObject({ lane: "ledger", profile: null, profileTask: null });
  expect(contextOf("sections").profileTask).toEqual({ finalize: [], synthesize: false });
  expect(contextOf("insights")).toMatchObject({ profileTask: null, profile: expect.any(Object) });
  expect((contextOf("insights") as { observations?: string[] }).observations)
    .toEqual(["准：你先搭框架再动手。", "部分对：你最投入的两次都有人等着结果。 → 本人更正：等结果的是我自己定的期限"]);
  expect(readLaneState(store, workspaceId, "s", "insights").readAt).toEqual(expect.any(String));
  expect(store.listProfileFacts(workspaceId).map((fact) => fact.slot)).toEqual(["deadline"]);
  expect(JSON.parse(store.getSetting(workspaceId, "profile.model")!)).toMatchObject({ problem: "论文和产品抢同一段时间" });
  for (const lane of ["ledger", "sections", "insights"] as const) expect(readLaneState(store, workspaceId, "s", lane)).toMatchObject({ upTo: 1, failures: 0 });
  expect(readExtractState(store, workspaceId, "s#sections").upTo).toBe(1);
});

test("a portrait lane that never ran starts at the single run's watermark: an interview from before the lanes is not read again", () => {
  const now = "2026-11-12T00:00:00.000Z";
  const ownerId = store.getWorkspaceOwnerId(workspaceId)!;
  store.saveOnboardingSession({ id: "s", ownerId, workspaceId, state: "complete", coverage: {}, createdAt: now, updatedAt: now });
  for (const text of ["一", "二"]) store.appendOnboardingMessage({ sessionId: "s", workspaceId, role: "user", content: { text }, createdAt: now });
  writeExtractState(store, workspaceId, "s", { upTo: 2, failures: 0, ranAt: now });
  const extractor = createOnboardingExtractor(store, workspaceId, "C:\\repo", () => undefined);
  expect(readLaneState(store, workspaceId, "s", "sections").upTo).toBe(2);
  expect(extractor.nextSession([], "sections")).toBeUndefined();
  expect(extractor.nextSession(["s"], "insights")).toBeUndefined();
  store.appendOnboardingMessage({ sessionId: "s", workspaceId, role: "user", content: { text: "三" }, createdAt: now });
  expect(extractor.nextSession([], "insights")).toBe("s");
  // A line's own interview and the notes are the ledger's only.
  store.saveOnboardingSession({ id: "line-research", ownerId, workspaceId, state: "active", coverage: {}, createdAt: now, updatedAt: now });
  store.appendOnboardingMessage({ sessionId: "line-research", workspaceId, role: "user", content: { text: "四" }, createdAt: now });
  expect(extractor.nextSession(["line-research"], "sections")).toBe("s");
  expect(extractor.nextSession(["line-research"], "ledger")).toBe("line-research");
});

test("the ledger lane moving on pins where a portrait lane that has not run starts, so a batch of replies waits for it", async () => {
  const now = new Date().toISOString();
  const ownerId = store.getWorkspaceOwnerId(workspaceId)!;
  store.saveOnboardingSession({ id: "s", ownerId, workspaceId, state: "active", coverage: { stage: "situation", flow: "v1", rules: "points" }, createdAt: now, updatedAt: now });
  const { rpc } = fakeRuntime([round], [ONBOARDING_SKILL, ONBOARDING_EXTRACT_SKILL], { routes: [{ match: EXTRACT, answers: [deadline([1]), deadline([1]), deadline([1])] }] });
  const extractor = createOnboardingExtractor(store, workspaceId, "C:\repo", () => rpc);
  for (const text of ["一", "二", "三"]) {
    store.appendOnboardingMessage({ sessionId: "s", workspaceId, role: "user", content: { text }, createdAt: now });
    expect((await extractor.runOnce(["s"], "ledger")).state).toBe("done");
  }
  expect(readLaneState(store, workspaceId, "s", "ledger").upTo).toBe(3);
  expect(readLaneState(store, workspaceId, "s", "sections")).toMatchObject({ upTo: 0, pinned: true });
  expect(extractor.nextSession([], "sections")).toBe("s");
});

test("under the points rules the sections' lane writes points with their quotes, and a stage's view only once the stage is over", async () => {
  // One reply, read by every lane at once: the portrait's batching is tested on its own.
  process.env.CROSSLINE_PORTRAIT_BATCH = "1";
  const now = "2026-11-12T00:00:00.000Z";
  const ownerId = store.getWorkspaceOwnerId(workspaceId)!;
  store.saveOnboardingSession({ id: "s", ownerId, workspaceId, state: "active", coverage: { stage: "situation", flow: "v1", rules: "points" }, createdAt: now, updatedAt: now });
  const sections = facts({ profileSections: { situation: { problem: "改写成段的处境", gravity: [], designable: [], reframes: [], refs: [1] }, compass: null, energy: null, synthesis: null },
    pointChanges: [
      { op: "add", id: "", section: "situation", text: "论文 12 月中投稿，和产品抢同一段时间", refs: [1], external: [], why: "" },
      { op: "add", id: "", section: "situation", text: "没有引用的要点", refs: [], external: [], why: "" }] });
  const { rpc, prompts } = fakeRuntime([round], [ONBOARDING_SKILL, ONBOARDING_EXTRACT_SKILL], { routes: [
    { match: '"lane":"sections"', answers: [sections] },
    { match: '"lane":"insights"', answers: [JSON.stringify({ hypotheses: [], careers: [], dimensions: [], dropCareers: [] })] },
    { match: EXTRACT, answers: [deadline([1])] }] });
  const run = createRunner(store, workspaceId, "C:\repo", () => rpc);
  expect((await run({ sessionId: "s", text: "论文 12 月中投稿，和产品在抢同一段时间。" })).state).toBe("asked");
  await extractionSettled(workspaceId);
  const prompt = prompts().find((item) => item.includes('"lane":"sections"'))!;
  expect(prompt).toContain('"rules":"points"');
  const profile = JSON.parse(store.getSetting(workspaceId, "profile.model")!) as { problem: string; points: Array<{ id: string; text: string; quotes: unknown[]; source: string }> };
  // The stage is under way: no paragraph, only the point that cites a sentence.
  expect(profile.problem).toBe("");
  expect(profile.points).toEqual([expect.objectContaining({ id: "p1", source: "stated", text: "论文 12 月中投稿，和产品抢同一段时间",
    quotes: [{ ref: "reply-1", text: "论文 12 月中投稿，和产品在抢同一段时间。" }] })]);
});

test("under the points rules a card that names no hypothesis on record becomes one in the log, and its round says which", async () => {
  const card = JSON.stringify({ reply: "收到。", questions: [{ id: "q2", text: "还有别的吗？", kind: "free", options: [], allowOther: true, identityId: "", projectId: "", repeats: 0 }],
    coverage: [], nextAction: "ask", stage: "energy",
    insights: [{ hypothesisId: "", dimension: "D2", text: "两次投入都和有人等结果有关", refs: [{ replyId: "reply-1", quote: "和同学赶比赛" }, { replyId: "reply-5", quote: "导师等着看图" }],
      external: [], falsifier: "没人等时也一样投入" }] });
  const { rpc } = runtime([round, round, card], [facts(), facts(), facts()]);
  const run = createRunner(store, workspaceId, "C:\repo", () => rpc, { extract: "off" });
  for (const text of ["和同学赶比赛那次最投入。", "还有一门课。", "组会前导师等着看图，那晚写到三点。"]) await run({ sessionId: "s", text });
  expect((store.getOnboardingSession(workspaceId, "s")!.coverage as { rules?: string }).rules).toBe("points");
  const last = store.listOnboardingMessages(workspaceId, "s").filter((message) => message.role === "assistant").at(-1)!;
  expect((last.content as { insight?: { hypothesisId?: string } }).insight?.hypothesisId).toBe("c5");
  const profile = JSON.parse(store.getSetting(workspaceId, "profile.model")!) as { hypotheses: Array<{ id: string; status: string; basis: Array<{ ref: string }> }> };
  expect(profile.hypotheses).toEqual([expect.objectContaining({ id: "c5", status: "open", basis: [expect.objectContaining({ ref: "reply-1" }), expect.objectContaining({ ref: "reply-5" })] })]);
});

test("a split run of an account moved to the points rules writes points only and leaves its paragraphs as they are", async () => {
  const { POINTS_SPLIT_SETTING } = await import("./onboarding-extract");
  const now = "2026-11-12T00:00:00.000Z";
  const ownerId = store.getWorkspaceOwnerId(workspaceId)!;
  store.saveOnboardingSession({ id: "s", ownerId, workspaceId, state: "complete", coverage: { stage: "energy", flow: "v1", rules: "points" }, createdAt: now, updatedAt: now });
  store.appendOnboardingMessage({ sessionId: "s", workspaceId, role: "user", content: { text: "论文 12 月中投稿，和产品在抢同一段时间。" }, createdAt: now });
  store.setSetting(workspaceId, "profile.model", JSON.stringify({ problem: "旧段落" }));
  store.setSetting(workspaceId, POINTS_SPLIT_SETTING, JSON.stringify(["situation"]));
  const { rpc, prompts } = runtime([], [facts({ profileSections: { situation: { problem: "改写成段的处境", gravity: [], designable: [], reframes: [], refs: [1] }, compass: null, energy: null, synthesis: null },
    pointChanges: [{ op: "add", id: "", section: "situation", text: "论文 12 月中投稿，和产品抢同一段时间", refs: [1], external: [], why: "" }] })]);
  const extractor = createOnboardingExtractor(store, workspaceId, "C:\repo", () => rpc);
  expect(extractor.nextSession([], "sections")).toBe("s");
  expect(await extractor.runOnce([], "sections")).toMatchObject({ state: "done" });
  expect(prompts().find((prompt) => prompt.includes(EXTRACT))).toContain('"split":["situation"]');
  const profile = JSON.parse(store.getSetting(workspaceId, "profile.model")!) as { problem: string; points: Array<{ text: string }> };
  expect(profile.problem).toBe("旧段落");
  expect(profile.points.map((point) => point.text)).toEqual(["论文 12 月中投稿，和产品抢同一段时间"]);
  expect(store.getSetting(workspaceId, POINTS_SPLIT_SETTING)).toBeUndefined();
});

test("while an interview is under way the portrait's lanes wait for three replies, or for the oldest to have waited ten minutes; the ledger never waits, and the inferences only while the log has cards to offer", () => {
  const ownerId = store.getWorkspaceOwnerId(workspaceId)!;
  const now = new Date().toISOString();
  store.saveOnboardingSession({ id: "s", ownerId, workspaceId, state: "active", coverage: { stage: "situation", flow: "v1" }, createdAt: now, updatedAt: now });
  const extractor = createOnboardingExtractor(store, workspaceId, "C:\repo", () => undefined);
  for (const text of ["一", "二"]) store.appendOnboardingMessage({ sessionId: "s", workspaceId, role: "user", content: { text }, createdAt: now });
  expect(extractor.nextSession([], "ledger")).toBe("s");
  expect(extractor.nextSession(["s"], "sections")).toBeUndefined();
  // The inferences wait too only once the log has two hypotheses to offer the next cards.
  expect(extractor.nextSession([], "insights")).toBe("s");
  const two = [{ kind: "quote", text: "一", ref: "reply-1" }, { kind: "quote", text: "二", ref: "reply-3" }];
  store.setSetting(workspaceId, "profile.model", JSON.stringify({ hypotheses: ["h1", "h2"].map((id) => ({ id, dimension: "D2", statement: "推断", basis: two,
    falsifier: "", alternative: "", status: "open" })) }));
  expect(extractor.nextSession([], "insights")).toBeUndefined();
  store.appendOnboardingMessage({ sessionId: "s", workspaceId, role: "user", content: { text: "三" }, createdAt: now });
  expect(extractor.nextSession(["s"], "sections")).toBe("s");
  // Two replies, the older eleven minutes old.
  store.saveOnboardingSession({ id: "t", ownerId, workspaceId, state: "active", coverage: { stage: "situation", flow: "v1" }, createdAt: now, updatedAt: now });
  store.appendOnboardingMessage({ sessionId: "t", workspaceId, role: "user", content: { text: "早" }, createdAt: new Date(Date.now() - 11 * 60_000).toISOString() });
  expect(extractor.nextSession(["t"], "insights")).toBe("t");
});
