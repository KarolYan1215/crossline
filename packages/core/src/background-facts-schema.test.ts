import { expect, test } from "vitest";
import { validateBackgroundFactsProposal, type BackgroundFactsContext } from "./background-facts-schema";

const context: BackgroundFactsContext = {
  version: "crossline.background-facts.v1",
  identities: [{ id: "research", label: "科研" }, { id: "startup", label: "创业" }],
  existingFacts: [],
  captureTitle: "整理三次实验结果",
  captureContext: "论文标题暂定《XX 方法在 YY 场景下的应用》，数据存在 ~/experiments/exp-3 目录下"
};

const output = (overrides: Partial<{
  facts: Array<{ identityId: string; key: string; value: string; why: string; sourceQuote: string }>;
  blockers: Array<{ code: string; message: string }>;
}> = {}) => ({
  facts: [{ identityId: "research", key: "paper_title", value: "XX 方法在 YY 场景下的应用",
    why: "捕获文本里给出的暂定论文标题", sourceQuote: "论文标题暂定《XX 方法在 YY 场景下的应用》" }],
  blockers: [],
  ...overrides
});

test("a well-formed proposal with a real quote passes through", () => {
  const result = validateBackgroundFactsProposal(output(), context);
  expect(result.facts).toHaveLength(1);
  expect(result.facts[0]!.key).toBe("paper_title");
  expect(result.facts[0]!.identityId).toBe("research");
});

test("no new facts this capture is a normal, valid result", () => {
  const result = validateBackgroundFactsProposal(output({ facts: [] }), context);
  expect(result.facts).toHaveLength(0);
});

test("a quote that is not verbatim in the capture is refused as fabricated", () => {
  expect(() => validateBackgroundFactsProposal(output({
    facts: [{ identityId: "research", key: "paper_title", value: "假标题", why: "x", sourceQuote: "这段话根本不在原文里" }]
  }), context)).toThrow("BACKGROUND_FACTS_EVIDENCE_INVALID");
});

test("a fact assigned to an identity the workspace doesn't have is refused", () => {
  expect(() => validateBackgroundFactsProposal(output({
    facts: [{ identityId: "media", key: "paper_title", value: "x", why: "x", sourceQuote: "论文标题暂定" }]
  }), context)).toThrow("BACKGROUND_FACTS_IDENTITY_UNKNOWN");
});

test("two facts with the same (identityId, key) in one turn are refused, but the same key under two different identities is fine", () => {
  expect(() => validateBackgroundFactsProposal(output({
    facts: [
      { identityId: "research", key: "paper_title", value: "A", why: "x", sourceQuote: "论文标题暂定" },
      { identityId: "research", key: "paper_title", value: "B", why: "y", sourceQuote: "论文标题暂定" }
    ]
  }), context)).toThrow("BACKGROUND_FACTS_DUPLICATE_KEY");

  const result = validateBackgroundFactsProposal(output({
    facts: [
      { identityId: "research", key: "paper_title", value: "A", why: "x", sourceQuote: "论文标题暂定" },
      { identityId: "startup", key: "paper_title", value: "B", why: "y", sourceQuote: "论文标题暂定" }
    ]
  }), context);
  expect(result.facts).toHaveLength(2);
});

test("a blocker stops the proposal and carries its own message as detail", () => {
  try {
    validateBackgroundFactsProposal(output({ facts: [], blockers: [{ code: "NOTHING_NEW", message: "这条捕获没有新信息" }] }), context);
    throw new Error("expected a throw");
  } catch (error) {
    expect((error as Error).message).toBe("BACKGROUND_FACTS_BLOCKED");
    expect((error as Error & { detail?: string }).detail).toBe("这条捕获没有新信息");
  }
});

test("malformed shape (not an array of facts) is refused before any business check runs", () => {
  expect(() => validateBackgroundFactsProposal({ facts: "nope", blockers: [] }, context))
    .toThrow("BACKGROUND_FACTS_SCHEMA_INVALID");
});
