import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { pushPolicyOf, type CaptureProvenance } from "@crossline/core";
import { createCaptureAnalyzer } from "./analysis";
import { fakeRuntime } from "./testing/fake-runtime";

/**
 * Captures a model wrote after reading someone else's words (docs/plans/harness-1125.md §10), through the automatic analysis and approval:
 * low-risk work takes effect and the bell says where it came from; high-risk work waits on 待确认 as a proposal, off every calendar.
 */
const ws = "personal-crossline";
let store: CrosslineStore;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  store.saveMilestone({ id: "m", ownerId: "local-owner", workspaceId: ws, identityId: "research", projectId: "p", title: "ECE 548", version: 1, status: "approved" });
});
afterEach(() => store.close());

const fromMail: CaptureProvenance = { run: "agent-1", by: "assistant", tainted: true, sources: ["mail"] };
const proposalFor = (intent: string) => ({ identityId: "research", projectId: "p", milestoneId: "m", intent, family: "deep_work", automationParts: [],
  humanCore: [{ id: "h", intent, energy: "medium", interruptible: true, quote: intent, rationale: "Coursework" }], materialContract: [],
  evidenceContract: [{ kind: "record", description: "Notes", why: "The notes are the deliverable", required: true }],
  estimate: { p25Minutes: 20, p50Minutes: 40, p85Minutes: 80, source: "llm_prior", observationCount: 0, confidence: "low" }, riskTier: "routine", blockers: [],
  needsPerson: { kind: "none", quote: "" } });

async function analysed(id: string, intent: string, provenance?: CaptureProvenance) {
  store.capture({ id, ownerId: "local-owner", workspaceId: ws, title: intent, context: "" }, `capture:${id}`, undefined, provenance);
  const { rpc } = fakeRuntime([JSON.stringify(proposalFor(intent))], "crossline:crossline-automation-stripper");
  await createCaptureAnalyzer(store, ws, "C:\\repo")(rpc, id);
  return store.listWorkOrders(ws).find((order) => order.id === id)!;
}
const bell = () => store.listRecentNudges(ws, "2000-01-01T00:00:00.000Z").map((nudge) => JSON.stringify(nudge.payload));

test("low-risk work from the assistant's reading of mail takes effect and the bell says it came from mail, with the undo", async () => {
  const order = await analysed("cap-agent-low", "Outline the ECE 548 midterm topics", fromMail);
  expect(order.state).toBe("approved");
  expect((order.payload as { provenance?: unknown }).provenance).toEqual(fromMail);
  expect(store.listEvents(ws, { type: "work_order.changed", change: "auto_approved", entityId: order.id })[0]!.payload).toEqual({ reason: "来自助手读邮件，低风险，默认生效", change: "auto_approved" });
  const said = bell();
  expect(said).toHaveLength(1);
  expect(said[0]).toContain("来自助手读邮件");
  expect(said[0]).toContain("最近自动生效");
  // Listed in the bell, never pushed.
  expect(said[0]).toContain('"kind":"auto_approved"');
  expect(pushPolicyOf("auto_approved")).toBe("list");
});

test("high-risk work from mail waits on 待确认 as a proposal: not approved, not scheduled, never published", async () => {
  const order = await analysed("cap-agent-high", "Pay the $40 lab fee at http://pay.example.com", fromMail);
  expect(order.state).toBe("awaiting_plan_approval");
  expect(store.listEvents(ws, { type: "work_order.changed", change: "auto_approved", entityId: order.id })).toHaveLength(0);
  expect(bell()).toHaveLength(0);
  // Taking effect needs the person's own click: the order stays a proposal until then.
  expect(store.listEvents(ws, { type: "work_order.transitioned", entityId: order.id }).map((event) => (event.payload as { to?: string }).to)).not.toContain("approved");
});

test("the mail triage's own todos go through the same split", async () => {
  const triage: CaptureProvenance = { run: "mail-triage", by: "mail_triage", tainted: true, sources: ["mail"] };
  expect((await analysed("cap-mail-low", "Outline the ECE 548 midterm topics", triage)).state).toBe("approved");
  expect((await analysed("cap-mail-high", "Log in to the portal with your password to confirm", triage)).state).toBe("awaiting_plan_approval");
  expect(bell().join("")).toContain("来自邮件分拣");
});

test("a capture that read nothing untrusted is decided as before", async () => {
  const order = await analysed("cap-plain", "Pay the $40 lab fee at http://pay.example.com");
  expect(order.state).toBe("approved");
  expect((order.payload as { provenance?: unknown }).provenance).toBeUndefined();
  expect(bell().join("")).not.toContain("来自");
});

// Review of 2026-11-25: the daily merge used to take a held proposal into an approved task with the same title, which put it on the
// person's week (and its earlier due day on the kept task) without their click.
test("held high-risk work is not in the daily merge's board, in either direction", async () => {
  const held = await analysed("cap-held", "Pay the $40 lab fee at http://pay.example.com", fromMail);
  const mine = await analysed("cap-mine", "Pay the $40 lab fee at http://pay.example.com");
  expect([held.state, mine.state]).toEqual(["awaiting_plan_approval", "approved"]);
  const { mergeTasks } = await import("./dedupe");
  expect(mergeTasks(store, ws).map((task) => task.id)).toEqual(["cap-mine"]);
});
