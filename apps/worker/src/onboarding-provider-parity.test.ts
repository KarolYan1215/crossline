import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { setProviderResolver, type ProviderRouting } from "@crossline/codex";
import { CrosslineStore } from "@crossline/db";
import { createOnboardingSessionRunner as createRunner, ONBOARDING_SKILL } from "./onboarding-session";
import { ONBOARDING_EXTRACT_SKILL } from "./onboarding-extract";
import { fakeRuntime, type AgentScript } from "./testing/fake-runtime";

/**
 * Interview parity (2026-11-26): a person on the developer's model or on a provider of their own gets the interview a ChatGPT sign-in
 * gets. The same rounds run on three routes, with the same assertions on what reaches the ledger:
 * - `codex`: no provider (the account's own Codex);
 * - `provider`: a third-party provider whose record admits the dialogue and its extraction and shows it calling functions;
 * - `provider-json`: the same provider, whose interview card-tools case failed (`callsFunctionsFor` false for the dialogue), so the
 *   dialogue runs in its one-JSON mode while the extraction keeps its tools.
 * No resolver is set on the Codex route; on the provider routes every thread must start on the provider (`modelProvider`), and the
 * account has no Codex sign-in, so a Skill the record does not admit would stop the round instead of quietly moving to Codex.
 */
const EXTRACT = "crossline.onboarding.extract.v1";
type Route = "codex" | "provider" | "provider-json";
const ROUTES: Route[] = ["codex", "provider", "provider-json"];

const routing = (route: Exclude<Route, "codex">): ProviderRouting => ({
  provider: { id: "sf", kind: "chat", label: "SiliconFlow", baseUrl: "https://api.siliconflow.cn/v1", model: "glm-5", keyLast4: "abcd", updatedAt: "2026-11-26T00:00:00.000Z" },
  gatewayUrl: "http://127.0.0.1:5555/x", admitted: new Set(["crossline-onboarding", "crossline-onboarding-extract"]), codexSignedIn: false, functionCalls: true,
  ...(route === "provider-json" ? { functionCallsFor: (skill: string) => skill !== "crossline-onboarding" } : {})
});

const turn = (over: Record<string, unknown> = {}) => JSON.stringify({
  reply: "收到，我先确认几件事。",
  questions: [{ id: "q1", text: "项目 A 的图表清单在哪？", kind: "single", allowOther: true, identityId: "research", projectId: "westlake", followUp: true,
    options: [{ id: "a", label: "师兄给的文档", detail: "" }, { id: "b", label: "只在聊天记录里", detail: "" }] }],
  slotUpdates: [], projectsDetected: [], flywheelCandidates: [], coverage: [], nextAction: "ask", next: "接着问项目 A 的图表清单。", ...over
});
const firstAnswer = turn({
  projectsDetected: [{ id: "westlake", identityId: "research", name: "西湖合作：MoS2 忆阻器片上训练", summary: "负责仿真和算法" }],
  slotUpdates: [{ identityId: "research", projectId: "westlake", slot: "deadline", value: "10/31 前投出", status: "confirmed", refs: [1] }],
  flywheelCandidates: [{ fromIdentityId: "research", toIdentityId: "media", kind: "informs", explanation: "研究过程是自媒体的选题来源", refs: [], status: "inferred" }],
  coverage: [{ identityId: "research", filled: ["deadline"], missing: ["stage"] }]
});

let store: CrosslineStore;
let workspaceId: string;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  workspaceId = store.createPrincipalWithWorkspace("user-1", "个人 workspace").workspace.id;
});
afterEach(() => { setProviderResolver(undefined); store.close(); });

const runtimeFor = (answers: string[], extract: string[], script?: AgentScript) =>
  fakeRuntime(answers, [ONBOARDING_SKILL, ONBOARDING_EXTRACT_SKILL], { routes: [{ match: EXTRACT, answers: extract }], ...(script ? { script } : {}) });
const runner = (runtime: ReturnType<typeof fakeRuntime>, extract: "await" | "off" = "await") =>
  createRunner(store, workspaceId, "C:\\repo", () => runtime.rpc, { extract, lanes: false });
/** Thread starts that declared `ask_question`: the dialogue in its card-tools mode. */
const cardThreads = (runtime: ReturnType<typeof fakeRuntime>) => runtime.threadStarts().flatMap((params, index) =>
  (params.dynamicTools as Array<{ name: string }> | undefined)?.some((tool) => tool.name === "ask_question") ? [`thread-${index + 1}`] : []);

describe.each(ROUTES)("the interview on the %s route", (route) => {
  beforeEach(() => { if (route !== "codex") setProviderResolver(() => routing(route)); });
  const onProvider = route !== "codex";
  const cardTools = route !== "provider-json";

  test("a first turn writes the projects, the cited facts with the person's own words, and both messages; every thread runs on the route", async () => {
    const runtime = runtimeFor([firstAnswer], [firstAnswer]);
    const run = runner(runtime);
    expect(await run({ sessionId: "s1", text: "西湖那篇 10/31 前要投出，数据下周到。" })).toEqual({ state: "asked", sessionId: "s1" });
    expect(store.listProjects(workspaceId).map((project) => project.name)).toEqual(["西湖合作：MoS2 忆阻器片上训练"]);
    const facts = store.listProfileFacts(workspaceId);
    expect(facts.find((fact) => fact.slot === "deadline")).toMatchObject({ value: "10/31 前投出", status: "confirmed", sourceRef: "reply-1",
      sourceQuote: "西湖那篇 10/31 前要投出，数据下周到。", sourceSentences: [1] });
    expect(facts.find((fact) => fact.slot === "flywheel_media_informs")).toMatchObject({ status: "inferred" });
    expect(store.listOnboardingMessages(workspaceId, "s1").map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(store.getOnboardingSession(workspaceId, "s1")).toMatchObject({ codexThreadId: expect.any(String), state: "active",
      coverage: { cardTools: cardTools ? "tools" : "fallback" } });
    // The dialogue and its extraction: two threads, both on the provider when there is one.
    const starts = runtime.threadStarts();
    expect(starts.length).toBeGreaterThanOrEqual(2);
    for (const start of starts) expect(start.modelProvider).toBe(onProvider ? "crossline-sf" : undefined);
    // The extraction keeps its tools on every route; only the dialogue's card tools follow their own case.
    expect(cardThreads(runtime)).toHaveLength(cardTools ? 1 : 0);
  });

  test("questions: handed in through the card tools and checked on the spot where the route passed that case, else in the one JSON answer", async () => {
    const replies: Array<Record<string, unknown>> = [];
    const bad = { id: "q-when", text: "哪段时间最空？", kind: "single", allowOther: true, identityId: "research", projectId: "",
      options: [{ id: "a", label: "周末", detail: "" }, { id: "a", label: "晚上", detail: "" }] };
    const good = { ...bad, options: [{ id: "a", label: "周末", detail: "" }, { id: "b", label: "晚上", detail: "" }] };
    let runtime!: ReturnType<typeof fakeRuntime>;
    // Where the card tools are declared the model hands its cards in and answers with no `questions`; where they are not, its one
    // JSON answer carries the card itself.
    runtime = runtimeFor([cardTools ? turn({ questions: [] }) : turn({ questions: [good] })], [turn()], async ({ threadId, ask }) => {
      if (!cardThreads(runtime).includes(threadId)) return;
      for (const question of [bad, good]) replies.push(await ask("item/tool/call", { callId: `c${replies.length}`, tool: "ask_question", arguments: question }));
    });
    await runner(runtime)({ sessionId: "s1", text: "西湖那篇 10/31 前要投出，数据下周到。" });
    const round = store.listOnboardingMessages(workspaceId, "s1").at(-1)!.content as { questions: Array<{ id: string }> };
    expect(round.questions.map((question) => question.id)).toEqual(["q-when"]);
    if (cardTools) {
      expect(replies.map((reply) => reply.success)).toEqual([false, true]);
      expect((replies[0]!.contentItems as Array<{ text: string }>)[0]!.text).toContain("选项 id 有重复");
    } else {
      expect(replies).toEqual([]);
      // The one-JSON mode is bound to the dialogue's schema.
      const dialogueTurn = runtime.turnParams().find((params) => !JSON.stringify(params.input ?? "").includes(EXTRACT))!;
      expect(dialogueTurn.outputSchema).toBeDefined();
    }
  });

  // The ledger-driven interview (§16): a round's verdicts and asked questions are written when it ends, and the next round's snapshot shows
  // them. `mark_round` is one of the card tools, so this is the card-tools mode's behaviour.
  test.runIf(cardTools)("a round's checklist verdicts and its own questions reach the ledger, and the next round opens on them", async () => {
    let calls = 0;
    const marks: AgentScript = async ({ ask }) => {
      calls += 1;
      await ask("item/tool/call", { callId: `m${calls}`, tool: "mark_round", arguments: calls === 1 ? { stage: "energy" } : { stage: "energy",
        checklist: [{ id: "portrait:method", status: "answered", basis: [{ ref: "reply-3", quote: "先做往年题" }], note: "" }],
        asked: [{ text: "学新东西时你先做什么？", gist: "学新东西的第一步", repeats: 0, followUp: false }] } });
    };
    const runtime = runtimeFor([turn(), "你备考先做往年题。学新东西时你先做什么？", "好。"], [], marks);
    const run = runner(runtime, "off");
    await run({ sessionId: "s", text: "先说经历" });
    await run({ sessionId: "s", text: "备考我先做往年题。" });
    expect(store.getOnboardingSession(workspaceId, "s")!.coverage).toMatchObject({ checklist: { "portrait:method": { status: "answered", round: 4 } } });
    const main = store.questionByKey(workspaceId, "iq:s:4:main-1")!;
    expect(main).toMatchObject({ status: "open", text: "学新东西时你先做什么？" });
    await run({ sessionId: "s", text: "先看一遍入门视频。" });
    expect(store.questionByKey(workspaceId, "iq:s:4:main-1")).toMatchObject({ status: "answered", answer: "先看一遍入门视频。" });
    const third = runtime.prompts().at(-1)!;
    expect(third.startsWith("〔账本快照 · 第 3 轮开始前")).toBe(true);
    expect(third).toContain("- portrait:method｜做事方法｜answered ← reply-3「先做往年题」");
    for (const start of runtime.threadStarts()) expect(start.modelProvider).toBe(onProvider ? "crossline-sf" : undefined);
  });
});

test("a provider that admits the dialogue but not its extraction does not run the interview on itself behind the person's back", async () => {
  setProviderResolver(() => ({ ...routing("provider"), admitted: new Set(["crossline-onboarding"]) }));
  const runtime = runtimeFor([firstAnswer], [firstAnswer]);
  await runner(runtime)({ sessionId: "s1", text: "西湖那篇 10/31 前要投出，数据下周到。" }).catch(() => undefined);
  // The extraction is never started on the provider (nor on a Codex the account does not have): no fact is written without it.
  expect(runtime.threadStarts()).toHaveLength(1);
  expect(runtime.prompts().some((prompt) => prompt.includes(EXTRACT))).toBe(false);
  expect(store.listProfileFacts(workspaceId).filter((fact) => fact.slot === "deadline")).toEqual([]);
});
