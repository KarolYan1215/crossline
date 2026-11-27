import { afterEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { ONBOARDING_INSIGHTS } from "@crossline/core";
import { interviewMetrics } from "./interview-metrics";

// P5 (docs/onboarding-agent-session.md §5): a replay's numbers, read from the ledger it left.
let store: CrosslineStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

test("a replay's metrics: questions and reflection per round, repeats, cards rated off, agreeing openings, items left out, time by stage", () => {
  store = new CrosslineStore(":memory:");
  const ws = store.createPrincipalWithWorkspace("user-1", "w").workspace.id;
  const ownerId = store.getWorkspaceOwnerId(ws)!;
  store.saveOnboardingSession({ id: "s1", ownerId, workspaceId: ws, state: "active", coverage: { cardTools: "tools" }, createdAt: "2026-11-14T00:00:00Z", updatedAt: "2026-11-14T00:00:00Z" });
  const say = (at: string, reply: string, questions: number, stage: string) => store!.appendOnboardingMessage({ sessionId: "s1", workspaceId: ws, role: "assistant", createdAt: at,
    content: { reply, stage, questions: Array.from({ length: questions }, (_, index) => ({ id: `q${index}`, text: "?" })) } });
  say("2026-11-14T00:00:00Z", "你说投入的两次都是和人一起。这和你说的一个人做研究不太一样。", 2, "narrative");
  say("2026-11-14T00:10:00Z", "对，就是这样。", 1, "narrative");
  say("2026-11-14T00:30:00Z", "那说说这几周。", 1, "situation");
  const at = "2026-11-14T00:00:00Z";
  store.recordQuestion(ws, { kind: "interview", key: "iq:s1:1:q0", text: "a", status: "open", at });
  store.recordQuestion(ws, { kind: "interview", key: "iq:s1:2:q0", text: "b", status: "open", repeats: 1, at });
  store.setSetting(ws, ONBOARDING_INSIGHTS, JSON.stringify({ "s1#1#0": { verdict: "off", stage: "narrative" }, "s1#2#0": { verdict: "fits", stage: "narrative" }, "s2#1#0": { verdict: "off" } }));
  store.appendEvent({ ownerId, workspaceId: ws, idempotencyKey: "e1", type: "onboarding.changed", entityId: "s1", payload: { removed: [{ text: "", why: "x" }], added: [], change: "round_edited" } });
  expect(interviewMetrics(store, ws, "s1")).toEqual({ rounds: 3, questionsPerRound: 1.33, reflectionPerQuestion: 1, repeatRate: 0.5, cardsOff: 0.5,
    agreeOpenings: 0.33, leftOut: 1, cardTools: "tools",
    stages: [{ stage: "narrative", rounds: 2, minutes: 30 }, { stage: "situation", rounds: 1, minutes: 0 }] });
});
