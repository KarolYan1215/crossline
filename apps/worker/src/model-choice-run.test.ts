import { afterEach, beforeEach, expect, test } from "vitest";
import { runCodexSkill, setEffortPreferenceProvider, setModelChoiceProvider, setProviderResolver, setSpendModeProvider, setUsageSink, type SkillUsage } from "@crossline/codex";
import { fakeRuntime } from "./testing/fake-runtime";

// A top-tier Skill that steps down when the budget is tight, so the choice's exemption shows.
const SKILL = "crossline:crossline-milestone-architect";
const options = (skillName: string) => ({
  skillName, cwd: "C:\\repo", developerInstructions: "x", outputSchema: {}, prepareInput: (input: unknown) => input,
  validateOutput: (output: unknown) => output, onAudit: () => {}, timeoutMs: 5_000
});

let usage: SkillUsage[] = [];
beforeEach(() => { usage = []; setUsageSink((record) => usage.push(record)); });
afterEach(() => { setUsageSink(undefined); setSpendModeProvider(undefined); setEffortPreferenceProvider(undefined); setModelChoiceProvider(undefined); setProviderResolver(undefined); });

test("the person's chosen model and effort win over the table, the economy step down and 模型强度 (D19)", async () => {
  setModelChoiceProvider((_workspace, skill) => skill === SKILL ? { model: "gpt-5.6-sol", effort: "xhigh" } : undefined);
  setSpendModeProvider(async () => "economy");
  setEffortPreferenceProvider(() => "lower");
  const { rpc } = fakeRuntime(["{}"], SKILL);
  const result = await runCodexSkill(rpc, {}, options(SKILL));
  expect(result.ok).toBe(true);
  expect(usage[0]).toMatchObject({ spendMode: "economy", model: "gpt-5.6-sol", effort: "xhigh" });
});

test("a spent ChatGPT quota is said, not handed to the developer's model, when the person chose the model", async () => {
  // The developer's model stands in for this Skill while the account's ChatGPT quota is spent.
  setProviderResolver(() => ({ provider: { id: "sponsor", kind: "responses", label: "开发者提供的模型", baseUrl: "https://example.invalid/v1", model: "dev-model",
    keyLast4: null, updatedAt: "2026-11-22T00:00:00Z" }, gatewayUrl: "http://127.0.0.1:1/x", admitted: new Set(["crossline-milestone-architect"]),
    codexSignedIn: true, chatgptExhausted: { until: "2026-11-23T08:00:00Z" } }) as never);
  setModelChoiceProvider(() => ({ model: "gpt-5.6-sol" }));
  const { rpc, turns } = fakeRuntime(["{}"], SKILL);
  const result = await runCodexSkill(rpc, {}, options(SKILL));
  expect(result).toMatchObject({ ok: false, blocker: { code: "SKILL_USAGE_LIMIT" } });
  expect(result.ok ? "" : result.blocker.message).toContain("gpt-5.6-sol");
  expect(turns()).toBe(0);
});

test("without a choice the table still decides, economy and all", async () => {
  setModelChoiceProvider(() => undefined);
  setSpendModeProvider(async () => "economy");
  const { rpc } = fakeRuntime(["{}"], SKILL);
  await runCodexSkill(rpc, {}, options(SKILL));
  expect(usage[0]).toMatchObject({ spendMode: "economy", model: "gpt-5.6-terra", effort: "medium" });
});
