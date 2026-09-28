import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { createBackgroundFactsExtractor, BACKGROUND_FACTS_SKILL } from "./background-facts-runner";
import { fakeRuntime as sharedRuntime } from "./testing/fake-runtime";

const fakeRuntime = (answers: string[]) => sharedRuntime(answers, BACKGROUND_FACTS_SKILL);

const WORKSPACE = "personal-crossline";
let store: CrosslineStore;

beforeEach(() => { store = new CrosslineStore(":memory:"); });
afterEach(() => store.close());

const proposal = {
  facts: [{ identityId: "research", key: "paper_title", value: "XX 方法在 YY 场景下的应用",
    why: "捕获文本里的暂定论文标题", sourceQuote: "论文标题暂定《XX 方法在 YY 场景下的应用》" }],
  blockers: []
};

test("extracted facts are merged into the named identity's background-facts bucket", async () => {
  const { rpc } = fakeRuntime([JSON.stringify(proposal)]);
  const extract = createBackgroundFactsExtractor(store, WORKSPACE, "/tmp", () => rpc);
  const outcome = await extract("整理三次实验结果", "论文标题暂定《XX 方法在 YY 场景下的应用》");

  expect(outcome).toMatchObject({ state: "extracted", factCount: 1 });
  const facts = store.getBackgroundFacts(WORKSPACE, "research");
  expect(facts).toHaveLength(1);
  expect(facts[0]).toMatchObject({ key: "paper_title", value: "XX 方法在 YY 场景下的应用" });
});

test("an empty facts array (nothing durable in this capture) is a normal, successful outcome", async () => {
  const { rpc } = fakeRuntime([JSON.stringify({ facts: [], blockers: [] })]);
  const extract = createBackgroundFactsExtractor(store, WORKSPACE, "/tmp", () => rpc);
  const outcome = await extract("买菜", "晚上做饭要用");

  expect(outcome).toMatchObject({ state: "extracted", factCount: 0 });
  expect(store.getBackgroundFacts(WORKSPACE, "research")).toEqual([]);
});

test("a new fact under an existing key overwrites it rather than duplicating", async () => {
  store.mergeBackgroundFacts(WORKSPACE, "research", [
    { key: "paper_title", value: "旧标题", why: "旧", sourceQuote: "旧引用" }
  ]);
  const { rpc } = fakeRuntime([JSON.stringify(proposal)]);
  const extract = createBackgroundFactsExtractor(store, WORKSPACE, "/tmp", () => rpc);
  await extract("整理三次实验结果", "论文标题暂定《XX 方法在 YY 场景下的应用》");

  const facts = store.getBackgroundFacts(WORKSPACE, "research");
  expect(facts).toHaveLength(1);
  expect(facts[0]?.value).toBe("XX 方法在 YY 场景下的应用");
});

test("empty capture input is refused before any Codex call runs", async () => {
  const { rpc, turns } = fakeRuntime([JSON.stringify(proposal)]);
  const extract = createBackgroundFactsExtractor(store, WORKSPACE, "/tmp", () => rpc);
  const outcome = await extract("", "");
  expect(outcome).toMatchObject({ state: "blocked", code: "BACKGROUND_FACTS_NO_INPUT" });
  expect(turns()).toBe(0);
});

test("no Codex client available is a typed blocker, not a throw", async () => {
  const extract = createBackgroundFactsExtractor(store, WORKSPACE, "/tmp", () => undefined);
  const outcome = await extract("整理三次实验结果", "有内容");
  expect(outcome).toMatchObject({ state: "blocked", code: "CODEX_SUPERVISOR_UNAVAILABLE" });
});
