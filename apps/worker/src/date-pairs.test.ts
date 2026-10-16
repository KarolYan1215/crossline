import { expect, test } from "vitest";
import { homeworkNumber } from "./date-pairs";

// 「RBT 610 作业 3 截止」 became the task 「完成 RBT 610 作业 610」 (2026-10-15 walkthrough): the course code is not the homework's number.
test("the homework's number is the one after 作业/HW, never the course code's", () => {
  expect(homeworkNumber("RBT 610 作业 3 截止")).toBe("3");
  expect(homeworkNumber("ECE555 HW #4 due")).toBe("4");
  expect(homeworkNumber("作业 2 发布")).toBe("2");
  expect(homeworkNumber("ECE 555 第 5 次作业截止")).toBe("5");
  expect(homeworkNumber("RBT 610 截止")).toBeUndefined();
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
