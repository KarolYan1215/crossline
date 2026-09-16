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
  const status = await (await fetch(`${supervisor.url}/v1/codex/status`)).json() as { state?: string };
  if (status.state !== "ready") throw new Error(`CODEX_PLUGIN_SMOKE_FAILED ${JSON.stringify(status)}`);
  console.log(JSON.stringify({ status: "ok", baselineCommit: CODEX_BASELINE_COMMIT, supervisor: status }));
} finally { await supervisor.stop(); }
