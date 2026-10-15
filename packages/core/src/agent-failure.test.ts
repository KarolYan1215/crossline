import { expect, test } from "vitest";
import { AGENT_MAX_RUNS, agentAskProgress, agentChains, classifyAgentFailure, resultNeedsPerson, retryDue, type AgentRunRow } from "./agent-failure";

const stop = (code: string, message = "", extra: Partial<AgentRunRow> = {}) => ({ status: "blocked", blockerCode: code, blockerMessage: message, ...extra });

test("an interruption is retried; something that could act outside the machine, a missing answer or a dead end is not", () => {
  for (const code of ["AGENT_RUN_LOST", "SKILL_STALLED", "SKILL_TIMEOUT", "SKILL_CANCELED", "SKILL_RUNTIME_EXITED", "SKILL_USAGE_LIMIT", "CODEX_SUPERVISOR_UNAVAILABLE"]) {
    expect(classifyAgentFailure(stop(code))).toMatchObject({ kind: "interrupted", retry: true, external: false });
  }
  expect(classifyAgentFailure({ status: "stale", blockerCode: "", blockerMessage: "" })).toMatchObject({ kind: "interrupted", retry: true });
  // The real card of 2026-10-15: a restart is said as it is, never as a code.
  expect(classifyAgentFailure(stop("AGENT_RUN_LOST", "后台进程重启，这次运行中断")).stuckAt).toBe("后台进程重启，这次运行中断");

  // A site's security check, a login, paying or sending: never again by itself, and the card says why.
  const check = classifyAgentFailure(stop("AGENT_LOOP_STOPPED", "读取网站被拒绝了 3 次仍在继续尝试，已自动停下"));
  expect(check).toMatchObject({ kind: "external", retry: false, external: true });
  expect(check.noRetryWhy).toContain("账号");
  expect(classifyAgentFailure(stop("AGENT_RUN_LOST", "", { siteStopped: true }))).toMatchObject({ kind: "external", retry: false });
  expect(classifyAgentFailure(stop("SKILL_STALLED", "", { deniedRules: ["send.mail"] }))).toMatchObject({ kind: "external", retry: false });
  expect(classifyAgentFailure(stop("X", "需要本人完成小红书安全验证"))).toMatchObject({ kind: "external" });
  expect(classifyAgentFailure(stop("X", "下单前需要付款"))).toMatchObject({ kind: "external" });

  expect(classifyAgentFailure(stop("AGENT_CANCELLED", "本人中止了这次运行。"))).toMatchObject({ kind: "needs_input", retry: false });
  expect(classifyAgentFailure(stop("X", "缺少 ECE 548 第 5 讲的讲义"))).toMatchObject({ kind: "needs_input", stuckAt: "缺少 ECE 548 第 5 讲的讲义" });
  expect(classifyAgentFailure(stop("X", "", { deniedRules: ["install.global"] }))).toMatchObject({ kind: "needs_input" });

  const hard = classifyAgentFailure(stop("AGENT_ARTIFACT_MISSING", "你说做了「a.md」，但任务目录里没有这个文件。"));
  expect(hard).toMatchObject({ kind: "hard", retry: false });
  expect(hard.stuckAt).not.toContain("a.md");
  expect(hard.workaround).toBeTruthy();
  expect(classifyAgentFailure(stop("AGENT_LOOP_STOPPED", "同一条命令重复执行了 4 次，已自动停下"))).toMatchObject({ kind: "hard" });
  expect(classifyAgentFailure(stop("X", "", { deniedRules: ["secret.path"] }))).toMatchObject({ kind: "hard" });
  // Never a bare code.
  expect(classifyAgentFailure(stop("SOMETHING_NEW", "SOMETHING_NEW")).stuckAt).not.toMatch(/[A-Z_]{5}/);
});

const at = (minutes: number) => new Date(Date.parse("2026-10-14T21:00:00Z") + minutes * 60_000).toISOString();
const run = (taskId: string, minute: number, extra: Partial<AgentRunRow> = {}): AgentRunRow => ({ taskId, workOrderId: "", stepId: "", title: "把这类事固化成工作流：整理收藏夹",
  requestedAt: at(minute), status: "blocked", blockerCode: "AGENT_RUN_LOST", blockerMessage: "后台进程重启，这次运行中断", endedAt: at(minute + 10), ...extra });

test("one rule for every run: interrupted runs come back after a growing wait, at most three in a row; the person's retry is due at once", () => {
  const [first] = agentChains([run("g1", 0)]);
  expect(first).toMatchObject({ state: "retry", retryAt: at(15) });
  expect(retryDue(first!, new Date(at(14)))).toBe(false);
  expect(retryDue(first!, new Date(at(15)))).toBe(true);
  expect(agentChains([run("g1", 0), run("g2", 20)])[0]).toMatchObject({ state: "retry", retryAt: at(60), retries: 1 });
  const exhausted = agentChains([run("g1", 0), run("g2", 20), run("g3", 70)])[0]!;
  expect(AGENT_MAX_RUNS).toBe(3);
  expect(exhausted).toMatchObject({ state: "stuck", retries: 2, failure: { kind: "interrupted" } });
  // The person asks again with their words: due now, the words carried, and the count starts over after it.
  const marks = { retries: [{ taskId: "g3", at: at(200), note: "只读收藏页第一页" }], closed: [] };
  expect(agentChains([run("g1", 0), run("g2", 20), run("g3", 70)], marks)[0]).toMatchObject({ state: "retry", retryAt: at(200), byPerson: true, notes: ["只读收藏页第一页"] });
  expect(agentChains([run("g1", 0), run("g2", 20), run("g3", 70), run("g4", 210)], marks)[0]).toMatchObject({ state: "retry", notes: ["只读收藏页第一页"] });
  // A later run that finished settles the chain: the real 小红书 request was grown again after the restart, so no card is due.
  expect(agentChains([run("g1", 0), run("g2", 20, { status: "accepted", blockerCode: "" })])[0]).toMatchObject({ state: "done" });
  // Closed by the person (they do it, or it is dropped): never again by itself.
  expect(agentChains([run("g1", 0)], { retries: [], closed: [{ taskId: "g1", at: at(30), how: "self" }] })[0]).toMatchObject({ state: "closed" });
  // Not interrupted: stuck at once, with no retry.
  expect(agentChains([run("g1", 0, { blockerCode: "AGENT_CANCELLED", blockerMessage: "本人中止了这次运行。" })])[0]).toMatchObject({ state: "stuck" });
  // A finished result the person wants redone is a retry too.
  expect(agentChains([run("g1", 0, { status: "needs_review", blockerCode: "" })], { retries: [{ taskId: "g1", at: at(40), note: "重做自检" }], closed: [] })[0])
    .toMatchObject({ state: "retry", notes: ["重做自检"] });
  // Runs of different work are apart: one step, a whole order, a workflow by its title.
  expect(agentChains([run("a", 0, { workOrderId: "wo", stepId: "s1" }), run("b", 0, { workOrderId: "wo", stepId: "" }), run("c", 0)])).toHaveLength(3);
});

test("a result is taken as accepted unless the person has to act, allow or judge something; keeping a grown workflow is not such a thing", () => {
  const clean = { needsHuman: [], checksPassed: true, inputsModified: [], decisions: [] };
  expect(resultNeedsPerson(clean)).toEqual([]);
  expect(resultNeedsPerson({ ...clean, needsHuman: [{ what: "确认用哪三篇文献" }] })[0]).toContain("确认用哪三篇文献");
  expect(resultNeedsPerson({ ...clean, checksPassed: false })).toEqual(["自检没有全部通过"]);
  expect(resultNeedsPerson({ ...clean, decisions: [{ rule: "publish.social", outcome: "declined" }] })).toEqual(["涉及对外发送、发布、上传或付款"]);
  expect(resultNeedsPerson({ ...clean, decisions: [{ rule: "install.global", decision: "ask", outcome: "accepted" }] })).toEqual(["运行中需要过本人的许可"]);
  const keep = { ...clean, needsHuman: [{ what: "决定是否在设置中保留该工作流" }] };
  expect(resultNeedsPerson({ ...keep, growing: true })).toEqual([]);
  expect(resultNeedsPerson(keep)).toHaveLength(1);
});

test("the progress on the card is in the person's words: what it did, where it stopped, what it needs, how often it was retried", () => {
  const failure = classifyAgentFailure(stop("AGENT_RUN_LOST", "后台进程重启，这次运行中断"));
  const progress = agentAskProgress({ title: "把这类事固化成工作流：定期整理小红书收藏夹", failure, retries: 2, exhausted: true,
    record: { commands: [{ command: "python a.py", exitCode: 0 }, { command: "python b.py", exitCode: 1 }],
      filesChanged: ["C:\\out\\grow-1\\skill\\SKILL.md", "C:\\out\\grow-1\\progress.json"], searches: ["小红书 收藏夹 导出"] } });
  expect(progress).toMatchObject({ external: false, retries: 2, stuckAt: "后台进程重启，这次运行中断；已自动重试 2 次，仍没做完" });
  expect(progress.done).toEqual(["查了 1 次资料：「小红书 收藏夹 导出」", "运行了 2 条命令，其中 1 条出错", "写出了 SKILL.md"]);
  expect(progress.needs[0]).toContain("再试一次");
  expect(progress.summary).toContain("定期整理");
});
