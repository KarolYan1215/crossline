/**
 * What an interview left for the rest of the app, read off a throwaway ledger (2026-10-30, the owner: does what the interview learned
 * become lines, milestones and settings, and reach every feature?).
 *
 *   pnpm exec tsx scripts/interview-handoff.ts <eval data dir> [--milestones] [--apply-settings]
 *
 * The data dir is the one `scripts/onboarding-eval.ts` prints as `dataDir`. Without flags it only reads: lines, projects and deadlines,
 * the hours the plan will use and where they came from, the person's facts, the settings the interview proposed, the date batch, the
 * portrait and the start items. `--apply-settings` applies the proposed settings through the web's own functions, as the start
 * confirmation does, and prints each setting before and after. `--milestones` runs the milestone architect on it (real quota) and prints
 * every draft with its deadline, criteria and the facts it cites. Never pointed at a real ledger: it refuses a dir without `eval` in its name.
 */
import { register } from "node:module";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setUsageSink, startCodexSupervisor } from "../packages/codex/src/index";
import { AVAILABILITY_PROPOSED_SETTING, AVAILABILITY_SETTING, INTERVIEW_SETTINGS, readInterviewSettings, resolveAvailability, type AccessContext } from "../packages/core/src/index";
import { CrosslineStore, interviewChecklistFor } from "../packages/db/src/index";
import { identityLines } from "../apps/worker/src/lines";
import { createMilestoneProposer } from "../apps/worker/src/milestone-proposer";

register("data:text/javascript,export async function resolve(s,c,n){if(s==='server-only')return{url:'data:text/javascript,',shortCircuit:true};return n(s,c)}");

const args = process.argv.slice(2);
const dataDir = args.find((arg) => !arg.startsWith("--"));
if (!dataDir || !/eval/.test(path.basename(dataDir)) || !existsSync(path.join(dataDir, "crossline.db"))) throw new Error("usage: interview-handoff.ts <crossline-onboarding-eval-* dir> [--milestones] [--apply-settings]");
const repoRoot = path.resolve(import.meta.dirname, "..");
const store = new CrosslineStore(path.join(dataDir, "crossline.db"));
const workspaceId = store.listWorkspaces()[0]!.id;
const out: string[] = [`# 访谈交接 · ${path.basename(dataDir)}`, ""];
const say = (...lines: string[]) => { out.push(...lines); console.info(lines.join("\n")); };
const json = <T>(key: string, fallback: T): T => { try { return JSON.parse(store.getSetting(workspaceId, key) ?? "") as T; } catch { return fallback; } };

const lines = identityLines(store, workspaceId);
const profiles = json<Record<string, { description?: string; attributes?: Array<{ text: string }> }>>("lines.profiles", {});
const facts = store.listProfileFacts(workspaceId);
const projects = store.listProjects(workspaceId).filter((project) => !project.id.endsWith("-default"));
say("## 主线与项目", "");
for (const line of lines) {
  say(`- **${line.label}**${line.hard ? "（固定日程）" : ""}：${profiles[line.id]?.description || "（无描述）"}`,
    `  - 长期目标：${line.goals?.[0] || "（未采用）"}；候选定语 ${profiles[line.id]?.attributes?.length ?? 0} 个：${(profiles[line.id]?.attributes ?? []).map((item) => item.text).join("、")}`);
  for (const project of projects.filter((item) => item.identityId === line.id)) {
    const own = facts.filter((fact) => fact.projectId === project.id);
    const deadline = own.find((fact) => fact.slot === "deadline")?.value ?? (own.some((fact) => fact.slot === "no_deadline") ? "没有截止" : "（未记录）");
    say(`  - 项目「${project.name}」截止：${deadline}；事实 ${own.length} 条（${own.map((fact) => fact.slot).join("、")}）`);
  }
}
const availability = resolveAvailability({ saved: store.getSetting(workspaceId, AVAILABILITY_SETTING), proposed: store.getSetting(workspaceId, AVAILABILITY_PROPOSED_SETTING), facts });
const minutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
const weekly = availability.windows.reduce((sum, window) => sum + window.days.length * (minutes(window.end) - minutes(window.start)), 0) / 60;
say("", "## 排程用的可用时段", "", `来源：${availability.source}；每周约 ${Math.round(weekly * 10) / 10} 小时`,
  ...availability.windows.map((window) => `- 周${window.days.join(",")} ${window.start}–${window.end} 精力${window.energy}`),
  `访谈理由：${json<{ why?: string }>(AVAILABILITY_PROPOSED_SETTING, {}).why ?? "（无）"}`);
say("", "## 关于本人的事实（person）", "", ...facts.filter((fact) => fact.identityId === "person")
  .map((fact) => `- ${fact.slot} [${fact.status}]：${fact.value.slice(0, 80)}`));
const settings = readInterviewSettings(store.getSetting(workspaceId, INTERVIEW_SETTINGS));
say("", "## 访谈提出的设置", "", ...(settings.length ? settings.map((item) => `- ${item.key}${item.target ? `(${item.target})` : ""} = ${item.value} [${item.state}]；依据「${item.quote.slice(0, 60)}」`) : ["（无）"]));
const batch = store.listEvents(workspaceId, { type: "dates.extracted" }).at(-1)?.payload as { dates?: unknown[]; recurring?: Array<{ title: string }>; undated?: unknown[] } | undefined;
say("", "## 日期", "", `单次 ${batch?.dates?.length ?? 0} 项，每周固定 ${batch?.recurring?.length ?? 0} 项（${(batch?.recurring ?? []).map((item) => item.title).join("、")}），待定 ${batch?.undated?.length ?? 0} 项`);
const model = json<Record<string, unknown>>("profile.model", {});
say("", "## 画像", "", ...Object.entries(model).filter(([, value]) => value && (typeof value === "string" ? value : (value as unknown[]).length))
  .map(([key, value]) => `- ${key}：${(typeof value === "string" ? value : JSON.stringify(value)).slice(0, 140)}`));
const checklist = interviewChecklistFor(store, workspaceId, lines.map((line) => ({ id: line.id, label: line.label, hard: Boolean(line.hard), goals: line.goals ?? [] })), { unfiledFiles: null });
say("", "## 开始标准", "", ...checklist.filter((item) => item.start).map((item) => `- ${item.done ? "✓" : "✗"} ${item.label}${item.done ? "" : `：${item.detail}`}`));

if (args.includes("--apply-settings") && settings.some((item) => item.state === "pending")) {
  process.env.CROSSLINE_DATA_DIR = dataDir;
  (globalThis as { crosslineStore?: unknown }).crosslineStore = store;
  const principal = store.listWorkOrders(workspaceId)[0]?.ownerId ?? "eval";
  const ctx = { principalId: principal, workspaceId, role: "owner", identity: { provider: "credential", issuer: "handoff", subject: principal }, authMethod: "session",
    requestId: "handoff" } as AccessContext;
  const { currentSettings } = await import("../apps/web/lib/setting-change");
  const { settleInterviewSettings } = await import("../apps/web/lib/start-confirm");
  const before = new Map((await currentSettings(ctx)).map((item) => [item.key, item.current]));
  const result = await settleInterviewSettings(ctx, new Set());
  const after = new Map((await currentSettings(ctx)).map((item) => [item.key, item.current]));
  say("", "## 应用后的设置", "", `应用 ${result.applied} 项，失败 ${result.failed} 项`,
    ...[...after].filter(([key, value]) => before.get(key) !== value).map(([key, value]) => `- ${key}：${before.get(key) || "（空）"} → ${value}`));
}

if (args.includes("--milestones")) {
  const supervisor = await startCodexSupervisor({ port: Number(process.env.CROSSLINE_CODEX_SUPERVISOR_PORT ?? 3392),
    plugin: { name: "crossline", marketplacePath: path.join(repoRoot, "skills", "marketplace", ".agents", "plugins", "marketplace.json"), cwd: repoRoot,
      requiredSkills: ["crossline:crossline-milestone-architect", "crossline:crossline-artifact-planner"] } });
  setUsageSink(() => {});
  try {
    const started = Date.now();
    const proposed = await createMilestoneProposer(store, workspaceId, repoRoot, () => supervisor.client)("");
    say("", `## 里程碑草稿（${Math.round((Date.now() - started) / 60_000)} 分钟）`, "");
    if (proposed.state !== "proposed") say(`未生成：${JSON.stringify(proposed).slice(0, 400)}`);
    const anchors = new Map(store.listMilestoneAnchors(workspaceId).map((anchor) => [anchor.milestoneId, anchor]));
    for (const line of lines) {
      const drafts = store.listMilestones(workspaceId).filter((milestone) => milestone.identityId === line.id && milestone.status === "draft");
      say(`### ${line.label}：${drafts.length} 个`);
      for (const draft of drafts) {
        const anchor = anchors.get(draft.id);
        say(`- ${anchor?.deadline ?? "（无日期）"} ${draft.title}`, `  - 标准：${draft.successCriteria.map((criterion) => criterion.description).join("；").slice(0, 200)}`,
          `  - 依据事实：${(anchor?.sourceFactIds ?? []).join("、") || "（无）"}`);
      }
    }
    const relations = store.listMilestoneRelations(workspaceId);
    say("", `跨线关系 ${relations.length} 条`, ...relations.map((relation) => `- ${relation.fromMilestoneId} → ${relation.toMilestoneId}（${relation.kind}，${relation.status}）`));
    if (proposed.state === "proposed" && proposed.assumptions?.length) say("", "假设：", ...proposed.assumptions.map((item: string) => `- ${item}`));
  } finally { await supervisor.stop(); }
}
const file = path.join(dataDir, "handoff.md");
writeFileSync(file, out.join("\n"));
console.info(JSON.stringify({ report: file }));
store.close();
