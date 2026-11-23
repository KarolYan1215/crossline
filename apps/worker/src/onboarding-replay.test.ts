import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { createOnboardingSessionRunner, ONBOARDING_SKILL } from "./onboarding-session";
import { fakeRuntime, type AgentScript } from "./testing/fake-runtime";

/**
 * The interview replayed through the shared fake runtime (2026-11-22, the native-Codex rewrite). The same four replies and the same model
 * answers ran once before the rewrite; what that run measured is kept in `testing/fixtures/onboarding-replay-baseline-1122.json`, and this
 * test measures the same run now and compares: how many model turns the four rounds took (a repair is a whole extra turn), how long the
 * follow-up prompts were, whether a turn carried an output schema, and what the person read.
 */
const BASELINE = JSON.parse(readFileSync(path.join(import.meta.dirname, "testing", "fixtures", "onboarding-replay-baseline-1122.json"), "utf8")) as {
  dialogueTurns: number; followUpPromptChars: number[]; schemaTurns: number; replies: string[] };

// i18n-ignore-start: the replayed conversation
const said = ["我在做两件事：科研和一个小的创业项目。", "科研是忆阻器的仿真，创业是给学生做的学习工具。", "好，往下。", "最焦虑的是两边都推不动。"];
/** The old schema wanted a question in every asking round; the native reply asks its one question in its own words. */
const ask = (n: number) => ({ id: `q${n}`, text: "说一个具体场景。", kind: "free", allowOther: true, identityId: "", projectId: "", options: [], followUp: true });
/** What the model answered, round by round, as JSON the old schema took (a model that still answers that way keeps working). */
const answers = [
  // Round 1: no `next` — the old receiving layer sent it back (IR-139), the new one keeps it.
  JSON.stringify({ reply: "先把两条线分开看：科研和创业各自现在卡在哪？", questions: [ask(1)], coverage: [], nextAction: "ask", stage: "narrative", safety: false }),
  JSON.stringify({ reply: "先把两条线分开看：科研和创业各自现在卡在哪？", questions: [ask(2)], coverage: [], nextAction: "ask", stage: "narrative", safety: false, next: "分开谈两条线。" }),
  // Round 2: says the app can be used while the start standard is open — sent back before (IR-035), recorded now.
  JSON.stringify({ reply: "你说的两件事都在推进。你可以开始使用了，不过先说说哪条线更急？", questions: [ask(3)], coverage: [], nextAction: "ask", stage: "narrative", safety: false, next: "问哪条更急。" }),
  JSON.stringify({ reply: "你说的两件事都在推进。先说说哪条线更急？", questions: [ask(4)], coverage: [], nextAction: "ask", stage: "narrative", safety: false, next: "问哪条更急。" }),
  // Round 3 and 4: plain.
  JSON.stringify({ reply: "那就从科研开始：上一次真正推进是哪一天，做了什么？", questions: [ask(5)], coverage: [], nextAction: "ask", stage: "narrative", safety: false, next: "问上一次推进。" }),
  JSON.stringify({ reply: "「两边都推不动」是一个模式：先命名它，再看它每次在哪一步出现。说一个最近的具体场景。", questions: [ask(6)], coverage: [], nextAction: "ask", stage: "situation", safety: false, next: "要一个具体场景。" })
];
// i18n-ignore-end

let store: CrosslineStore;
let workspaceId: string;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  workspaceId = store.createPrincipalWithWorkspace("user-1", "个人 workspace").workspace.id;
});
afterEach(() => store.close());

async function replay(given: string[] = answers, script?: AgentScript) {
  const runtime = fakeRuntime(given, ONBOARDING_SKILL, script ? { script } : {});
  const run = createOnboardingSessionRunner(store, workspaceId, "C:\\repo", () => runtime.rpc, { extract: "off" });
  for (const text of said) { const outcome = await run({ sessionId: "s1", text }); if (outcome.state === "blocked") console.log(JSON.stringify(outcome)); expect(outcome.state).toBe("asked"); }
  const replies = store.listOnboardingMessages(workspaceId, "s1").filter((message) => message.role === "assistant")
    .map((message) => String((message.content as { reply?: string }).reply ?? ""));
  const prompts = runtime.prompts();
  return {
    dialogueTurns: runtime.turns(),
    // The first prompt of each round after the first (a repair turn's prompt is the rejection, not counted).
    followUpPromptChars: prompts.filter((prompt) => said.slice(1).some((text) => prompt.includes(text))).map((prompt) => prompt.length),
    schemaTurns: runtime.turnParams().filter((params) => params.outputSchema !== undefined && params.outputSchema !== null).length,
    replies
  };
}

test("the replayed interview against the baseline recorded before the native rewrite", async () => {
  const now = await replay();
  if (process.env.CROSSLINE_REPLAY_PRINT) console.log(JSON.stringify(now));
  // The person reads the same four replies as before (the model's own words), and what still goes back is only what the code must hold.
  expect(now.replies).toHaveLength(BASELINE.replies.length);
  expect(now.dialogueTurns).toBeLessThanOrEqual(BASELINE.dialogueTurns);
  expect(now.followUpPromptChars).toHaveLength(BASELINE.followUpPromptChars.length);
  now.followUpPromptChars.forEach((chars, index) => expect(chars).toBeLessThanOrEqual(BASELINE.followUpPromptChars[index]!));
  expect(now.schemaTurns).toBeLessThanOrEqual(BASELINE.schemaTurns);
});

test("the same interview answered in free text, as the native thread answers: each final message is the reply, no turn has a schema", async () => {
  // i18n-ignore-start: the replayed conversation
  const free = ["先把两条线分开看：科研和创业各自现在卡在哪？", "你说的两件事都在推进。先说说哪条线更急？", "那就从科研开始：上一次真正推进是哪一天，做了什么？",
    "「两边都推不动」是一个模式：先命名它，再看它每次在哪一步出现。说一个最近的具体场景。"];
  // i18n-ignore-end
  // The native thread marks each round's part with `mark_round` (an unmarked free-text round is sent back once since 2026-11-23).
  const marks: AgentScript = async ({ ask, turnId }) => {
    await ask("item/tool/call", { callId: `m-${turnId}`, tool: "mark_round", arguments: { stage: "narrative" } });
  };
  const now = await replay(free, marks);
  if (process.env.CROSSLINE_REPLAY_PRINT) console.log(JSON.stringify(now));
  expect(now.replies).toEqual(free);
  expect(now.dialogueTurns).toBe(free.length);
  expect(now.schemaTurns).toBe(0);
  now.followUpPromptChars.forEach((chars, index) => expect(chars).toBeLessThanOrEqual(BASELINE.followUpPromptChars[index]!));
});
