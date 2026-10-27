/**
 * Installs a list of public skills into the machine owner's library through the resident worker — the same entry 「按链接添加」 on
 * Settings → Skill 库 uses (`/v1/skills/public/install` → `installPublicSkillFromLink`), so every entry is fetched, scanned and reviewed
 * exactly as the scout's own finds are (docs/skills-library.md §2). One at a time; each result is printed as it ends.
 *
 *   pnpm exec tsx scripts/install-skills.ts [--file scripts/skills-picks.json] [--only <n,n|repo#path>] [--workspace <id>] [--env .env.local]
 *   pnpm exec tsx scripts/install-skills.ts --dry-run      # fetch + licence + scan on this machine only: no worker, no model, no ledger
 *
 * The list is JSON: [{ repo, path, lineId, why, category? }]. The capability is signed with this machine's own supervisor secret, as the
 * web app signs it. The ledger is opened read-only (to find the owner); the worker writes what an installation writes.
 * `--dry-run` reads `GITHUB_TOKEN` when set, only for api.github.com, to stay under the unauthenticated rate limit.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { signCapability } from "../packages/codex/src/capability";

type SkillPick = { repo: string; path: string; lineId: string; why?: string; category?: string };
type Status = { ok?: boolean; jobId?: string; state?: string; id?: string; final?: string; reason?: string; message?: string; lines?: string[]; blocker?: { code?: string; message?: string } };

const arg = (name: string) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : undefined; };
const repoRoot = path.resolve(import.meta.dirname, "..");
const listFile = path.resolve(repoRoot, arg("file") ?? path.join("scripts", "skills-picks.json"));
const all = JSON.parse(readFileSync(listFile, "utf8")) as SkillPick[];
if (!Array.isArray(all) || !all.every((item) => typeof item?.repo === "string" && typeof item.path === "string" && typeof item.lineId === "string"))
  throw new Error(`${listFile}: expected [{ repo, path, lineId, why }]`);
const only = arg("only")?.split(",").map((item) => item.trim()).filter(Boolean);
const picks = all.filter((item, index) => !only || only.includes(String(index + 1)) || only.includes(`${item.repo}#${item.path}`));
const label = (item: SkillPick, index: number) => `${String(index + 1).padStart(2)} ${item.repo.replace("https://github.com/", "")}/${item.path} → ${item.lineId}`;

if (process.argv.includes("--dry-run")) {
  const { fetchSkillDirectory } = await import("../apps/worker/src/public-skills");
  const { scanSkillFiles, skillFrontmatter } = await import("../packages/core/src/public-skills");
  const token = process.env.GITHUB_TOKEN?.trim();
  const http = (url: string) => fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000), headers: { "user-agent": "crossline-skill-library",
    accept: url.startsWith("https://api.github.com/") ? "application/vnd.github+json" : "text/plain",
    ...(token && url.startsWith("https://api.github.com/") ? { authorization: `Bearer ${token}` } : {}) } });
  for (const [index, item] of picks.entries()) {
    const fetched = await fetchSkillDirectory(item, http);
    if (!fetched.ok) { console.log(`${label(item, index)}\n    不收：${fetched.reason}`); continue; }
    const front = skillFrontmatter(fetched.files.find((file) => file.path === "SKILL.md")?.text ?? "");
    const scan = scanSkillFiles(fetched.files);
    console.log(`${label(item, index)}\n    ${front ? front.name : "SKILL.md 没有 name 和 description"} · ${fetched.license} · ${fetched.commit.slice(0, 7)} · ${fetched.files.length} 个文件`
      + `${fetched.skipped.length ? `（跳过 ${fetched.skipped.length}）` : ""} · 扫描 ${scan.risk}${scan.injection ? "，含注入语句（会被拒）" : ""}`
      + `${scan.findings.length ? `：${[...new Set(scan.findings.map((finding) => finding.rule))].join("、")}` : ""}`);
  }
  process.exit(0);
}

const envFile = path.resolve(repoRoot, arg("env") ?? ".env.local");
const secret = readFileSync(envFile, "utf8").split(/\r?\n/).map((line) => /^CROSSLINE_SUPERVISOR_CAPABILITY_SECRET=(.*)$/.exec(line)?.[1]?.trim()).find(Boolean)
  ?? (() => { throw new Error(`no CROSSLINE_SUPERVISOR_CAPABILITY_SECRET in ${envFile}`); })();
const base = process.env.CROSSLINE_SUPERVISOR_URL ?? "http://127.0.0.1:3211";

type Row = { id?: string; principal_id?: string };
const Database = (await import("../packages/db/node_modules/better-sqlite3/lib/index.js")).default as unknown as
  new (file: string, options?: object) => { prepare: (sql: string) => { get: (...args: unknown[]) => Row | undefined }; close: () => void };
const ledger = new Database(path.join(repoRoot, "data", "crossline.db"), { readonly: true, fileMustExist: true });
const workspaceId = arg("workspace") ?? ledger.prepare("SELECT workspace_id AS id FROM settings WHERE key = 'deployment.runtimeOwner' LIMIT 1").get()?.id
  ?? (() => { throw new Error("no machine-owner workspace; pass --workspace"); })();
const principalId = ledger.prepare("SELECT principal_id FROM workspace_members WHERE workspace_id = ? AND role = 'owner' LIMIT 1").get(workspaceId)?.principal_id
  ?? (() => { throw new Error(`no owner for ${workspaceId}`); })();
ledger.close();

const status = await (await fetch(`${base}/v1/codex/status`)).json() as { supervisorBootId?: string };
if (!status.supervisorBootId) throw new Error("the worker's supervisor did not answer; is the resident worker running?");
const call = async (method: "GET" | "POST", pathname: string, body?: unknown): Promise<{ status: number; answer: Status }> => {
  const capability = signCapability({ principalId, workspaceId, role: "owner", operation: `${method} ${pathname}`,
    requestId: `install-skills-${Date.now()}`, supervisorBootId: status.supervisorBootId! }, secret);
  const response = await fetch(`${base}${pathname}`, { method, headers: { "content-type": "application/json", "x-crossline-capability": capability },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, answer: await response.json().catch(() => ({})) as Status };
};

const POLL_MS = 5000;
const WAIT_MS = 45 * 60_000;
const tally: Record<string, number> = {};
for (const [index, item] of picks.entries()) {
  const started = await call("POST", "/v1/skills/public/install", { repo: item.repo, path: item.path, lineId: item.lineId, why: item.why ?? "", category: item.category ?? "" });
  let result: Status = started.answer;
  if (started.status === 202 && started.answer.jobId) {
    const until = Date.now() + WAIT_MS;
    while (Date.now() < until && (!result.state || result.state === "running")) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      result = (await call("GET", `/v1/skills/public/install/${started.answer.jobId}`)).answer;
    }
  }
  const state = result.state ?? "failed";
  tally[state] = (tally[state] ?? 0) + 1;
  const detail = state === "installed" ? `${result.id}（${result.final === "text_only" ? "只用文字" : "可用"}）`
    : state === "already" ? `${result.id}，主线 ${result.lines?.join("、")}` : state === "rejected" ? result.reason
    : state === "running" ? "仍在审查，稍后在 Skill 库查看" : result.message ?? result.blocker?.message ?? `HTTP ${started.status}`;
  console.log(`${label(item, index)}\n    ${state}：${detail}`);
}
console.log(Object.entries(tally).map(([state, count]) => `${state} ${count}`).join(" · "));
