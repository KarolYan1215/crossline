import { expect, test } from "vitest";

// Which release and which due are one piece of work is the reading model's `work` label (2026-11-22): the homework-number regex it
// replaces knew only homework and once read 「RBT 610 作业 3 截止」 as homework 610. Any line's work pairs, and a date read before the
// label existed is not paired at all.
test("an adopted release and due with the same work label become one task, on any line; unlabelled dates make none", async () => {
  const { CrosslineStore } = await import("@crossline/db");
  const { materializeDatePairs } = await import("./date-pairs");
  const store = new CrosslineStore(":memory:"), ws = "ws";
  const at = "2026-10-01T00:00:00.000Z";
  store.saveProject({ id: "acme", ownerId: "o", workspaceId: ws, identityId: "work", name: "Acme 提案", status: "active", summary: "", createdAt: at, updatedAt: at });
  store.saveMilestone({ id: "m", ownerId: "o", workspaceId: ws, identityId: "work", projectId: "acme", title: "Acme 合同签下", status: "approved", version: 1 });
  const adopt = (id: string, date: string, kind: string, title: string, extra: object) => {
    store.appendEvent({ ownerId: "o", workspaceId: ws, idempotencyKey: `dates:${id}`, type: "dates.extracted", entityId: id,
      payload: { dates: [{ id, date, startTime: "", endTime: "", kind, title, project: "Acme 提案", sourceRef: "src-1", quote: title, confidence: "high", note: "", ...extra }] } });
    store.upsertProfileFact({ workspaceId: ws, identityId: "work", projectId: "acme", slot: `date_${date.replaceAll("-", "")}_${kind}`, value: `${date} ${title}`,
      status: "confirmed", sourceRef: "src-1", sourceQuote: title, updatedAt: at });
  };
  adopt("r", "2026-10-20", "release", "客户发来第二轮需求", { work: "第二轮方案" });
  adopt("d", "2026-11-03", "due", "第二轮方案交付", { work: "第二轮方案" });
  adopt("old", "2026-11-10", "homework_due", "作业 4 截止", {});
  const created = materializeDatePairs(store, ws, new Date("2026-10-15T12:00:00Z"));
  expect(created).toHaveLength(1);
  expect(store.getWorkOrder(ws, created[0]!)!).toMatchObject({ intent: "完成 Acme 提案 第二轮方案",
    payload: { dueDate: "2026-11-03", notBefore: "2026-10-20", datePair: { work: "第二轮方案", releaseDay: "2026-10-20" } } });
  store.close();
});

test("a homework waits for its release instead of being scheduled from the planned day, and its own file is the answer", async () => {
  const { CrosslineStore } = await import("@crossline/db");
  const { releaseWaits } = await import("./date-pairs");
  const store = new CrosslineStore(":memory:"), ws = "ws";
  store.saveProject({ id: "ece555", ownerId: "o", workspaceId: ws, identityId: "research", name: "ECE 555", status: "active", summary: "",
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" });
  const order = (id: string, number: string, state: string) => store.saveWorkOrder({ id, ownerId: "o", workspaceId: ws, identityId: "research", projectId: "ece555",
    milestoneId: "m", intent: `完成 ECE 555 作业 ${number}`, state: state as "approved", riskTier: "milestone",
    estimate: { p25Minutes: 120, p50Minutes: 180, p85Minutes: 360, source: "identity_prior", observationCount: 0, confidence: "low" },
    payload: { datePair: { releaseDay: "2026-10-12", dueDay: "2026-11-02", number } } });
  order("hw2", "2", "approved"); order("hw3", "3", "approved"); order("hw5", "5", "active");
  const doc = (name: string, sha: string) => store.saveSourceDocument({ id: sha, ownerId: "o", workspaceId: ws, kind: "docx", fileName: name, mediaType: "",
    sha256: sha, uri: "", extractedText: "", extractionStatus: "done", createdAt: "2026-10-15T00:00:00.000Z" });
  doc("Downloads/ECE555-F26-Homework2.docx", "a");
  doc("Downloads/ECE_548_Homework-3.pdf", "b");  // another course's homework 3 is not this one
  expect(releaseWaits(store, ws)).toEqual({ opened: ["wait-release-hw3"], arrived: [] });
  expect(store.listWaitingItems(ws)).toMatchObject([{ id: "wait-release-hw3", title: "ECE 555 作业 3 发布", followUpAt: "2026-10-12", state: "open", blocks: ["hw3"] }]);
  expect(releaseWaits(store, ws)).toEqual({ opened: [], arrived: [] });
  doc("ECE555/HW3.pdf", "c");
  expect(releaseWaits(store, ws)).toEqual({ opened: [], arrived: ["wait-release-hw3"] });
  expect(store.listWaitingItems(ws)[0]!.state).toBe("arrived");
});

// W-169: on 2026-11-01 homework 3 was due the next day with no time on the calendar, waiting on 「提供ECE 555 作业3题面」 while the sheet
// had already come in from the person's Downloads.
test("the homework's own file settles the step that asks the person for its problems, and files it under the course", async () => {
  const { CrosslineStore, provisionsOf } = await import("@crossline/db");
  const { normalizeStepPlan } = await import("@crossline/core");
  const { settleHomeworkNeeds } = await import("./date-pairs");
  const store = new CrosslineStore(":memory:"), ws = "ws";
  store.saveProject({ id: "ece555", ownerId: "o", workspaceId: ws, identityId: "research", name: "ECE 555", status: "active", summary: "",
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" });
  store.saveWorkOrder({ id: "hw3", ownerId: "o", workspaceId: ws, identityId: "research", projectId: "ece555", milestoneId: "m", intent: "完成 ECE 555 作业 3",
    state: "active", riskTier: "milestone", estimate: { p25Minutes: 120, p50Minutes: 180, p85Minutes: 360, source: "identity_prior", observationCount: 0, confidence: "low" },
    payload: { datePair: { releaseDay: "2026-10-12", dueDay: "2026-11-02", number: "3" } } });
  const step = (id: string, title: string, uses: string[]) => ({ id, role: "practice" as const, title, deliverable: "", doneCriterion: "x", share: 0.5,
    estimate: { p25Minutes: 20, p50Minutes: 30, p85Minutes: 45 }, dependsOn: [], notBefore: "", dueBy: "", schedulable: true, executor: "human" as const,
    tickOutcome: "", covers: [], why: "", product: "ability" as const, uses });
  const raw = { archetypeId: "problem_set", quantity: { basis: "", amount: 0, unit: "" }, rationale: "", units: [], questions: [],
    steps: [step("a", "完成第 1 题", ["n1", "n2"])],
    needs: [{ id: "n1", what: "ECE 555 作业3题面或 Canvas 公告", why: "确定题目", basis: "课程表", kind: "personal" as const },
      { id: "n2", what: "Canvas 提交入口", why: "提交", basis: "课程表", kind: "personal" as const }] };
  store.saveStepPlan(ws, "hw3", normalizeStepPlan(raw).plan, "o", "planned");
  const doc = (name: string, sha: string) => store.saveSourceDocument({ id: sha, ownerId: "o", workspaceId: ws, kind: "docx", fileName: name, mediaType: "",
    sha256: sha, uri: "", extractedText: "", extractionStatus: "done", createdAt: "2026-10-31T00:00:00.000Z" });
  doc("Downloads/ECE_548_Homework-3.pdf", "other");
  expect(settleHomeworkNeeds(store, ws)).toEqual([]);
  doc("Downloads/F26-Homework3-ECE555.docx.txt", "sheet");
  expect(settleHomeworkNeeds(store, ws)).toMatchObject([{ workOrderId: "hw3", documentId: "sheet" }]);
  // Only the step asking for the problems: the submission page is still the person's to give.
  expect([...provisionsOf(store, ws, "hw3")]).toEqual([["n1", "file"]]);
  expect(store.listSourceDocuments(ws).find((item) => item.id === "sheet")?.projectId).toBe("ece555");
  expect(settleHomeworkNeeds(store, ws)).toEqual([]);
  store.close();
});
