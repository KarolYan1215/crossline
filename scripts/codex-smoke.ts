import path from "node:path";
import { CODEX_BASELINE_COMMIT, startCodexSupervisor } from "../packages/codex/src/index";

const repoRoot = path.resolve(import.meta.dirname, "..");
const supervisor = await startCodexSupervisor({
  port: 0,
  plugin: {
    name: "crossline",
    marketplacePath: path.join(repoRoot, "skills", "marketplace", ".agents", "plugins", "marketplace.json"),
    cwd: repoRoot,
    requiredSkills: ["crossline:crossline-automation-stripper"]
  }
});
try {
  const status = await (await fetch(`${supervisor.url}/v1/codex/status`)).json() as {
    state?: string; contract?: { runtimeVersion?: string; relationStatus?: string }
  };
  if (status.state !== "ready" || status.contract?.relationStatus !== "verified"
    || !status.contract.runtimeVersion?.startsWith("crossline/0.155.0 "))
    throw new Error(`CODEX_FORK_SMOKE_FAILED ${JSON.stringify(status)}`);
  const started = await supervisor.client.request("thread/start", {
    cwd: repoRoot, sandbox: "read-only", approvalPolicy: "untrusted", ephemeral: true
  }) as { thread?: { id?: string }; approvalPolicy?: string; sandbox?: { type?: string } };
  if (!started.thread?.id || started.approvalPolicy !== "untrusted" || started.sandbox?.type !== "readOnly")
    throw new Error(`CODEX_THREAD_SMOKE_FAILED ${JSON.stringify(started)}`);
  console.log(JSON.stringify({ status: "ok", baselineCommit: CODEX_BASELINE_COMMIT,
    threadId: started.thread.id, supervisor: status }));
} finally { await supervisor.stop(); }
