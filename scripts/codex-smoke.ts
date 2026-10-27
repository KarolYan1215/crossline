import path from "node:path";
import { CODEX_BASELINE_COMMIT, startCodexSupervisor } from "../packages/codex/src/index";

const repoRoot = path.resolve(import.meta.dirname, "..");
// A real secret, even though nothing here signs a matching token: this smoke test's job is to prove the
// live compiled binary + real HTTP server actually enforce the capability gate stage four added, not
// just that the unit tests (which start the supervisor with no secret at all) agree with themselves.
const supervisor = await startCodexSupervisor({
  port: 0,
  capabilitySecret: "codex-smoke-capability-secret",
  plugin: {
    name: "crossline",
    marketplacePath: path.join(repoRoot, "skills", "marketplace", ".agents", "plugins", "marketplace.json"),
    cwd: repoRoot,
    requiredSkills: ["crossline:crossline-automation-stripper"]
  }
});
try {
  const status = await (await fetch(`${supervisor.url}/v1/codex/status`)).json() as {
    state?: string; contract?: { runtimeVersion?: string; relationStatus?: string }; supervisorBootId?: string
  };
  if (status.state !== "ready" || status.contract?.relationStatus !== "verified"
    || !status.contract.runtimeVersion?.startsWith("crossline/0.163.0 ") || typeof status.supervisorBootId !== "string")
    throw new Error(`CODEX_FORK_SMOKE_FAILED ${JSON.stringify(status)}`);
  // `/v1/codex/status` is the one route exempt from the gate — everything else must refuse a request
  // that carries no capability token, proving the gate is actually wired into the real HTTP path.
  const gated = await fetch(`${supervisor.url}/v1/work-orders/smoke-test/prepare-materials`, {
    method: "POST", headers: { "content-type": "application/json" }
  });
  const gatedBody = await gated.json() as { blocker?: { code?: string } };
  if (gated.status !== 401 || gatedBody.blocker?.code !== "CAPABILITY_MISSING")
    throw new Error(`CODEX_CAPABILITY_SMOKE_FAILED ${gated.status} ${JSON.stringify(gatedBody)}`);
  const started = await supervisor.client.request("thread/start", {
    cwd: repoRoot, sandbox: "read-only", approvalPolicy: "untrusted", ephemeral: true
  }) as { thread?: { id?: string }; approvalPolicy?: string; sandbox?: { type?: string } };
  if (!started.thread?.id || started.approvalPolicy !== "untrusted" || started.sandbox?.type !== "readOnly")
    throw new Error(`CODEX_THREAD_SMOKE_FAILED ${JSON.stringify(started)}`);
  console.log(JSON.stringify({ status: "ok", baselineCommit: CODEX_BASELINE_COMMIT,
    threadId: started.thread.id, supervisor: status }));
} finally { await supervisor.stop(); }
