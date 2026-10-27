/**
 * Runs one grown workflow now on this machine's resident worker, as its owner — the same entry the 「立即运行」 button on
 * Settings → Skill 库 uses (`/v1/workflows/:id/run` → `startWorkflowRun`), for checking a workflow end to end without a browser
 * session (docs/skills-library.md §8). The capability is signed with this machine's own supervisor secret, as the web app signs it.
 *
 *   pnpm exec tsx scripts/run-workflow.ts --workflow <id> [--workspace <id>] [--env .env.local]
 *
 * Read-only on the ledger itself; the worker writes what a run writes.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { signCapability } from "../packages/codex/src/capability";

const arg = (name: string) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : undefined; };
const workflow = arg("workflow") ?? (() => { throw new Error("missing --workflow"); })();
const repo = path.resolve(import.meta.dirname, "..");
const envFile = path.resolve(repo, arg("env") ?? ".env.local");
const secret = readFileSync(envFile, "utf8").split(/\r?\n/).map((line) => /^CROSSLINE_SUPERVISOR_CAPABILITY_SECRET=(.*)$/.exec(line)?.[1]?.trim()).find(Boolean)
  ?? (() => { throw new Error(`no CROSSLINE_SUPERVISOR_CAPABILITY_SECRET in ${envFile}`); })();
const base = process.env.CROSSLINE_SUPERVISOR_URL ?? "http://127.0.0.1:3211";

type Row = { id?: string; principal_id?: string };
const Database = (await import("../packages/db/node_modules/better-sqlite3/lib/index.js")).default as unknown as
  new (file: string, options?: object) => { prepare: (sql: string) => { get: (...args: unknown[]) => Row | undefined }; close: () => void };
const ledger = new Database(path.join(repo, "data", "crossline.db"), { readonly: true, fileMustExist: true });
const workspaceId = arg("workspace") ?? ledger.prepare("SELECT workspace_id AS id FROM settings WHERE key = 'deployment.runtimeOwner' LIMIT 1").get()?.id
  ?? (() => { throw new Error("no machine-owner workspace; pass --workspace"); })();
const principalId = ledger.prepare("SELECT principal_id FROM workspace_members WHERE workspace_id = ? AND role = 'owner' LIMIT 1").get(workspaceId)?.principal_id
  ?? (() => { throw new Error(`no owner for ${workspaceId}`); })();
ledger.close();

const status = await (await fetch(`${base}/v1/codex/status`)).json() as { supervisorBootId?: string };
if (!status.supervisorBootId) throw new Error("the worker's supervisor did not answer; is the resident worker running?");
const pathname = `/v1/workflows/${encodeURIComponent(workflow)}/run`;
const capability = signCapability({ principalId, workspaceId, role: "owner", operation: `POST ${pathname}`,
  requestId: `run-workflow-${Date.now()}`, supervisorBootId: status.supervisorBootId }, secret);
const response = await fetch(`${base}${pathname}`, { method: "POST", headers: { "content-type": "application/json", "x-crossline-capability": capability }, body: "{}" });
console.log(response.status, await response.text());
