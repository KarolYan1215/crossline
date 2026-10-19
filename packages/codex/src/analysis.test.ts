import { expect, test } from "vitest";
import * as codex from "./index";

const context = {
  version: "crossline.analysis.v1", capture: { title: "Compare notes and decide", context: "" },
  approvedMilestones: [{ id: "m", projectId: "p", identityId: "research", title: "Compare notes", version: 1, hasSuccessCriteria: true }],
  availableInputs: [], identityPacks: [{ id: "research", version: 1, summary: "Human judgment" }],
  historicalStats: [], policy: { tools: [], externalSideEffects: false, humanApprovalRequired: true }
};
const proposal = {
  identityId: "research", projectId: "p", milestoneId: "m", intent: "Compare notes and decide", family: "deep_work",
  automationParts: [], humanCore: [{ id: "h", intent: "Compare and decide", energy: "medium", interruptible: true, quote: "decide", rationale: "Human judgment" }],
  materialContract: [], evidenceContract: [{ kind: "record", description: "Decision", why: "The decision is the deliverable", required: true }],
  estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" }, riskTier: "routine", blockers: []
};

function runtime(output = JSON.stringify(proposal), status = "completed", error: unknown = null) {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  let skillEnabled = false;
  const client = new codex.JsonLineRpcClient((line) => {
    const req = JSON.parse(line);
    requests.push(req);
    let result: unknown;
    if (req.method === "skills/list") result = { data: [{ cwd: "C:\\repo", errors: [], skills: [{ name: "crossline-automation-stripper", path: "C:\\skill\\SKILL.md", enabled: skillEnabled }] }] };
    if (req.method === "skills/config/write") { skillEnabled = req.params.enabled; result = { effectiveEnabled: skillEnabled }; }
    if (req.method === "account/read") result = { account: { type: "chatgpt" }, requiresOpenaiAuth: false };
    if (req.method === "config/read") result = { config: {} };
    if (req.method === "thread/start") result = { thread: { id: "thread-1" }, approvalPolicy: "untrusted", sandbox: { type: "readOnly" }, instructionSources: [] };
    if (req.method === "turn/start") {
      result = { turn: { id: "turn-1", status: "inProgress" } };
      setTimeout(() => {
        client.receiveLine(JSON.stringify({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", id: "msg-1", text: output, phase: "final_answer" } } }));
        client.receiveLine(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status, items: [], error } } }));
      }, 0);
    }
    queueMicrotask(() => client.receiveLine(JSON.stringify({ id: req.id, result })));
  });
  return { client, requests };
}

test("real RPC boundary isolates one analysis thread and collects a strict final result with audit IDs", async () => {
  const fake = runtime();
  const audits: unknown[] = [];
  const result = await codex.runCodexAnalysis(fake.client, context, { skillName: "crossline-automation-stripper", cwd: "C:\\repo", onAudit: (audit) => audits.push(audit) });
  expect(result).toMatchObject({ ok: true, proposal, audit: { threadId: "thread-1", turnId: "turn-1" } });
  expect(audits).toEqual([{ threadId: "thread-1" }, { threadId: "thread-1", turnId: "turn-1" }]);
  expect(fake.requests.find((r) => r.method === "thread/start")?.params).toMatchObject({ environments: [], dynamicTools: [], approvalPolicy: "untrusted", sandbox: "read-only", model: "gpt-5.6-terra" });
  expect(fake.requests.find((r) => r.method === "turn/start")?.params).toMatchObject({ environments: [], outputSchema: { additionalProperties: false }, model: "gpt-5.6-terra", effort: "high" });
  expect(fake.requests.find((r) => r.method === "thread/start")?.params).not.toHaveProperty("baseInstructions");
  expect(fake.requests.find((r) => r.method === "turn/start")?.params.input).toMatchObject([{ text: expect.stringMatching(/^\$crossline-automation-stripper\n\n/) }]);
  expect(fake.requests.filter((r) => r.method === "skills/config/write").map((r) => r.params)).toEqual([
    { path: "C:\\skill\\SKILL.md", enabled: true }, { path: "C:\\skill\\SKILL.md", enabled: false }
  ]);
});

test("two runs of one Skill may overlap: it is switched on once, held by both, and switched back off by the last", async () => {
  const fake = runtime();
  await Promise.all([
    codex.runCodexAnalysis(fake.client, context, { skillName: "crossline-automation-stripper", cwd: "C:\\repo", onAudit: () => {} }),
    codex.runCodexAnalysis(fake.client, context, { skillName: "crossline-automation-stripper", cwd: "C:\\repo", onAudit: () => {} })
  ]);
  expect(fake.requests.filter((request) => request.method === "thread/start")).toHaveLength(2);
  expect(fake.requests.filter((request) => request.method === "skills/config/write").map((request) => request.params.enabled))
    .toEqual([true, false]);
  // Alone, a run switches its Skill on and back off as before.
  await codex.runCodexAnalysis(fake.client, context, { skillName: "crossline-automation-stripper", cwd: "C:\\repo", onAudit: () => {} });
  expect(fake.requests.filter((request) => request.method === "skills/config/write").map((request) => request.params.enabled))
    .toEqual([true, false, true, false]);
});

test("a missing native skill blocks before a thread starts", async () => {
  let client: codex.JsonLineRpcClient;
  const methods: string[] = [];
  client = new codex.JsonLineRpcClient((line) => {
    const request = JSON.parse(line);
    methods.push(request.method);
    queueMicrotask(() => client.receiveLine(JSON.stringify({ id: request.id, result: { data: [{ cwd: "C:\\repo", errors: [], skills: [] }] } })));
  });
  expect(await codex.runCodexAnalysis(client, context, { skillName: "crossline-automation-stripper", cwd: "C:\\repo", onAudit: () => {} }))
    .toMatchObject({ ok: false, blocker: { code: "ANALYSIS_SKILL_MISSING" } });
  expect(methods).toEqual(["skills/list"]);
});

test("runtime exit after turn/start is a safe immediate blocker, not a timeout", async () => {
  let client: codex.JsonLineRpcClient;
  client = new codex.JsonLineRpcClient((line) => {
    const req = JSON.parse(line);
    const result = req.method === "skills/list" ? { data: [{ cwd: "C:\\repo", errors: [], skills: [{ name: "crossline-automation-stripper", path: "C:\\skill\\SKILL.md", enabled: true }] }] }
      : req.method === "account/read" ? { account: { type: "chatgpt" } } : req.method === "config/read" ? { config: {} }
      : req.method === "thread/start" ? { thread: { id: "t" }, approvalPolicy: "untrusted", sandbox: { type: "readOnly" }, instructionSources: [] } : { turn: { id: "u" } };
    queueMicrotask(() => client.receiveLine(JSON.stringify({ id: req.id, result })));
    if (req.method === "turn/start") setTimeout(() => client.disconnect(new Error("CODEX_APP_SERVER_EXITED")), 1);
  });
  const result = await codex.runCodexAnalysis(client, context, { skillName: "crossline-automation-stripper", cwd: "C:\\repo", onAudit: () => {}, timeoutMs: 40 });
  expect(result).toMatchObject({ ok: false, blocker: { code: "ANALYSIS_RUNTIME_EXITED" }, audit: { threadId: "t", turnId: "u" } });
});

test.each([
  ["not JSON secret raw", "completed", "ANALYSIS_SCHEMA_INVALID"],
  [JSON.stringify({ ...proposal, injected: "secret" }), "completed", "ANALYSIS_SCHEMA_INVALID"],
  // A turn the runtime rejected is a failure, not the model declining: reporting it as "refused"
  // hid malformed requests behind a word that points the reader at the wrong thing.
  ["", "failed", "ANALYSIS_TURN_FAILED"]
])("invalid/refused output %s stays a redacted blocker", async (output, status, code) => {
  const fake = runtime(output, status);
  const result = await codex.runCodexAnalysis(fake.client, context, { skillName: "crossline-automation-stripper", cwd: "C:\\repo", onAudit: () => {} });
  expect(result).toMatchObject({ ok: false, blocker: { code } });
  expect(JSON.stringify(result)).not.toContain("secret");
});

test("timeout and cancellation settle without raw data", async () => {
  let client: codex.JsonLineRpcClient;
  client = new codex.JsonLineRpcClient((line) => { const req = JSON.parse(line); if (req.method === "skills/list") queueMicrotask(() => client.receiveLine(JSON.stringify({ id: req.id, result: { data: [{ cwd: "C:\\repo", errors: [], skills: [{ name: "crossline-automation-stripper", path: "C:\\skill\\SKILL.md", enabled: true }] }] } }))); });
  expect(await codex.runCodexAnalysis(client, context, { skillName: "crossline-automation-stripper", cwd: "C:\\repo", onAudit: () => {}, timeoutMs: 10 })).toMatchObject({ ok: false, blocker: { code: "ANALYSIS_TIMEOUT" } });
  expect(await codex.runCodexAnalysis(client, context, { skillName: "crossline-automation-stripper", cwd: "C:\\repo", onAudit: () => {}, signal: AbortSignal.abort() })).toMatchObject({ ok: false, blocker: { code: "ANALYSIS_CANCELED" } });
});

test("unauthenticated account cannot start a thread", async () => {
  const methods: string[] = [];
  const client = new codex.JsonLineRpcClient((line) => { const req = JSON.parse(line); methods.push(req.method); const result = req.method === "skills/list" ? { data: [{ cwd: "C:\\repo", errors: [], skills: [{ name: "crossline-automation-stripper", path: "C:\\skill\\SKILL.md", enabled: true }] }] } : { account: null, requiresOpenaiAuth: true }; queueMicrotask(() => client.receiveLine(JSON.stringify({ id: req.id, result }))); });
  expect(await codex.runCodexAnalysis(client, context, { skillName: "crossline-automation-stripper", cwd: "C:\\repo", onAudit: () => {} })).toMatchObject({ ok: false, blocker: { code: "ANALYSIS_UNAUTHENTICATED" } });
  expect(methods).toEqual(["skills/list", "account/read"]);
});

test("a spent usage quota is reported as its own blocker, not as a refusal", async () => {
  const fake = runtime("", "failed", { codexErrorInfo: "usageLimitExceeded", message: "You've hit your usage limit." });
  const result = await codex.runCodexAnalysis(fake.client, context, { skillName: "crossline-automation-stripper", cwd: "C:\\repo", onAudit: () => {} });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  // Calling a quota limit a refusal would hide the only action available to the person.
  expect(result.blocker.code).toBe("ANALYSIS_USAGE_LIMIT");
  expect(result.blocker.message).toContain("额度");
  expect(JSON.stringify(result.blocker)).not.toContain("usageLimitExceeded");
});
