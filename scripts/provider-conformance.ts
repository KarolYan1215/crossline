/**
 * The conformance gate for one model connection, run for real (R7): every exported `*_SCHEMA` plus the three adversarial cases,
 * through the same path the worker uses — the model gateway, a Codex app-server in a throwaway CODEX_HOME, the test-only
 * `crossline-conformance` Skill and the repair loop — on a throwaway ledger. Prints the table and which functions the connection
 * may serve; writes the record as JSON next to the ledger.
 *
 *   pnpm exec tsx scripts/provider-conformance.ts <chat|responses> <baseUrl> <model> [keyEnvName] [json_object]
 *
 * The key, when the connection needs one, is read from the environment variable *named* by `keyEnvName` — this script never takes a
 * key as an argument. `PROBE_CASES=A,B` limits the run to those case ids (a smoke test).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { admittedSkills, conformanceCases, SKILL_NEEDS } from "../packages/core/src/index";
import { startCodexAppServer, startCodexSupervisor, startModelGateway } from "../packages/codex/src/index";
import { createMemorySecretStore } from "../packages/connectors/src/secret-file";
import { CrosslineStore } from "../packages/db/src/index";
import { createModelProviderService } from "../apps/worker/src/model-provider";

const [kind, baseUrl, model, keyEnv, format] = process.argv.slice(2);
if ((kind !== "chat" && kind !== "responses") || !baseUrl || !model) {
  console.error("usage: provider-conformance.ts <chat|responses> <baseUrl> <model> [keyEnvName] [json_object]");
  process.exit(2);
}
const repoRoot = path.resolve(import.meta.dirname, "..");
process.env.CROSSLINE_CODEX_PATH ??= path.resolve(repoRoot, "../../../vendor/codex/codex-rs/target/debug/codex.exe");
const dataDir = mkdtempSync(path.join(tmpdir(), "crossline-conformance-"));
const store = new CrosslineStore(path.join(dataDir, "crossline.db"));
const { workspace } = store.createPrincipalWithWorkspace("conformance-check", "check");
const home = path.join(dataDir, "codex-home");
const supervisor = await startCodexSupervisor({ port: 3380 + Math.floor(Math.random() * 9), sidecarFactory: () => startCodexAppServer(home),
  plugin: { name: "crossline", marketplacePath: path.join(repoRoot, "skills", "marketplace", ".agents", "plugins", "marketplace.json"),
    cwd: repoRoot, requiredSkills: ["crossline:crossline-conformance"] } });

let service: ReturnType<typeof createModelProviderService>;
const gateway = await startModelGateway({ resolve: (workspaceId, providerId) => service.upstream(workspaceId, providerId) });
service = createModelProviderService({ store, secrets: createMemorySecretStore(), gateway, signedIn: () => false,
  client: async () => supervisor.client, cwd: repoRoot });
const label = `${kind}:${model}`;
const saved = await service.handle("POST", "/v1/model/provider", workspace.id, { id: "check", kind, label: label.slice(0, 40), baseUrl, model,
  ...(keyEnv ? { apiKey: process.env[keyEnv] ?? "" } : {}), ...(format === "json_object" ? { responseFormat: "json_object" } : {}) });
if (saved?.status !== 200) { console.error(JSON.stringify(saved?.body)); process.exit(1); }

const only = process.env.PROBE_CASES?.split(",").map((item) => item.trim()).filter(Boolean);
const cases = conformanceCases().filter((item) => !only?.length || only.includes(item.id));
console.info(JSON.stringify({ step: "start", label, cases: cases.length, runs: cases.reduce((sum, item) => sum + item.runs, 0), dataDir }));
const started = Date.now();
const record = await service.runConformance(workspace.id, cases);
await supervisor.stop();
await gateway.close();
if ("blocked" in record) { console.error(JSON.stringify(record)); process.exit(1); }

const byCase = new Map<string, { ok: number; runs: number; repairs: number; ms: number[]; codes: string[] }>();
for (const run of record.runs) {
  const row = byCase.get(run.caseId) ?? { ok: 0, runs: 0, repairs: 0, ms: [], codes: [] };
  row.runs += 1; row.ok += run.ok ? 1 : 0; row.repairs += run.repairs; row.ms.push(run.ms); if (run.code) row.codes.push(run.code);
  byCase.set(run.caseId, row);
}
console.info("\ncase | ok/runs | repairs | seconds | codes");
for (const [id, row] of byCase) console.info(`${id} | ${row.ok}/${row.runs} | ${row.repairs} | ${row.ms.map((ms) => Math.round(ms / 1000)).join(",")} | ${row.codes.join(",")}`);
const admitted = admittedSkills(record);
console.info(`\npassRate ${(record.passRate * 100).toFixed(1)}% · repairRate ${(record.repairRate * 100).toFixed(1)}% · p95 ${Math.round(record.p95Ms / 1000)} s · total ${Math.round((Date.now() - started) / 60000)} min`);
console.info(`admitted: ${admitted.map((skill) => SKILL_NEEDS[skill]?.label).join("、") || "none"}`);
const out = path.join(dataDir, "conformance.json");
writeFileSync(out, JSON.stringify({ label, baseUrl, record, admitted }, null, 2), "utf8");
console.info(JSON.stringify({ step: "done", out }));
process.exit(0);
