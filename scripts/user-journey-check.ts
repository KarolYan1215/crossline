/**
 * The whole path as the person lives it, against the real Codex, on a throwaway database:
 *
 *   uploaded course files + the profile they told us  →  interview  →  date batch  →  milestone drafts (per project, with
 *   cross-line relations)  →  approval  →  the capture they are actually blocked on  →  analysis
 *
 *   pnpm exec tsx scripts/user-journey-check.ts
 *
 * It exists because every unit test passed while the real account's 主线 page showed milestones for one project out of four, no
 * cross-line link at all, and a task blocked with a bare error code. Each step prints what a person would see, and the checks at
 * the end are the ones that were false on the real account. Approval here is a test account approving its own drafts; on a real
 * account approving is the person's decision and is never done for them. The manualbook step is `manualbook-check.ts`'s job. It spends real quota, so it is never run as a side effect.
 */
// Relative imports, not @crossline/*: the repo root is not a workspace package, so it has no such deps.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setUsageSink, startCodexSupervisor } from "../packages/codex/src/index";
import { CrosslineStore, latestFileDates } from "../packages/db/src/index";
import { profileGaps } from "../packages/core/src/index";
import { capturesAwaitingAutoAnalysis, createCaptureAnalyzer } from "../apps/worker/src/analysis";
import { extractText, sha256 } from "../apps/worker/src/extract";
import { createMilestoneProposer } from "../apps/worker/src/milestone-proposer";
import { createOnboardingSessionRunner } from "../apps/worker/src/onboarding-session";

const repoRoot = path.resolve(import.meta.dirname, "..");
const dataDir = mkdtempSync(path.join(tmpdir(), "crossline-journey-"));
const store = new CrosslineStore(path.join(dataDir, "crossline.db"));
const { workspace, principal } = store.createPrincipalWithWorkspace("user-journey-check", "journey");
const workspaceId = workspace.id;
const failures: string[] = [];
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.info(JSON.stringify({ check: label, ok, ...(detail === undefined ? {} : { detail }) }));
  if (!ok) failures.push(label);
};
const startedAt = Date.now();
let lastMark = startedAt;
/** Wall-clock since the previous step, so the limits the runners run under are set from what steps really take. */
const lap = () => { const now = Date.now(); const seconds = Math.round((now - lastMark) / 1000); lastMark = now; return seconds; };
const say = (label: string, value: unknown) => console.info(JSON.stringify({ step: label, seconds: lap(), ...(typeof value === "object" ? value as object : { value }) }));
setUsageSink((usage) => console.info(JSON.stringify({ run: usage.skillName.replace(/^crossline:crossline-/, ""), ok: usage.ok, turns: usage.turns, repairs: usage.repairs,
  outputTokens: usage.outputTokens, seconds: Math.round(usage.durationMs / 1000), turnSeconds: usage.turnSeconds, ...(usage.errorCode ? { error: usage.errorCode } : {}) })));

// 1. The files the person actually uploaded (course export folder, same four documents).
const downloads = path.join(process.env.USERPROFILE ?? "", "Downloads");
const files: Array<[string, "pdf" | "docx"]> = [
  [path.join(downloads, "course_files_export", "F26-ECE555-Syllabus.pdf"), "pdf"],
  [path.join(downloads, "course_files_export", "F26-ECE555-Course Schedule.pdf"), "pdf"],
  [path.join(downloads, "Course Overview.docx"), "docx"]
];
for (const [file, kind] of files.filter(([file]) => existsSync(file))) {
  const bytes = new Uint8Array(readFileSync(file));
  const extracted = await extractText(bytes, kind);
  const saved = store.saveSourceDocument({ id: `doc-${path.basename(file)}`, ownerId: principal.id, workspaceId, kind, fileName: path.basename(file),
    mediaType: kind === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sha256: sha256(bytes), uri: pathToFileURL(file).toString(), extractedText: "", extractionStatus: "pending", createdAt: new Date().toISOString() });
  store.setSourceDocumentExtraction(workspaceId, saved.id, { status: extracted.status, text: extracted.text, ...(extracted.note ? { note: extracted.note } : {}) });
}
say("files", store.listSourceDocuments(workspaceId).map((doc) => `${doc.fileName}:${doc.extractionStatus}:${doc.extractedText.length}`));

const profileFile = path.join(repoRoot, "data", "profile", "karolyan1215.profile.md");
const story = existsSync(profileFile)
  ? readFileSync(profileFile, "utf8").replace(/^>.*$/gm, "").replace(/\n{3,}/g, "\n\n").slice(0, 3800)
  : "我是 UW-Madison ECE 博士生。项目 A：西湖 MoS2，10/31 前投出；项目 B：hippocampus sleep replay 硬件；上 ECE 555 和 ECE 548；创业项目 Crossline；自媒体小红书；美股投资。";

const supervisor = await startCodexSupervisor({
  port: Number(process.env.CROSSLINE_CODEX_SUPERVISOR_PORT ?? 3399),
  plugin: {
    name: "crossline",
    marketplacePath: path.join(repoRoot, "skills", "marketplace", ".agents", "plugins", "marketplace.json"),
    cwd: repoRoot,
    requiredSkills: ["crossline:crossline-onboarding", "crossline:crossline-milestone-architect", "crossline:crossline-automation-stripper",
      "crossline:crossline-manualbook-designer", "crossline:crossline-material-researcher", "crossline:crossline-material-writer"]
  }
});
const getClient = () => supervisor.client;

try {
  // 2. The interview, in the person's own words, with the files already in.
  const interview = createOnboardingSessionRunner(store, workspaceId, repoRoot, getClient);
  const first = await interview({ sessionId: "journey", text: `${story}\n\n以上是我目前的真实情况，请据此整理，并把文件里的日期读出来。` });
  say("interview", first);
  check("interview_answered", first.state === "asked" || first.state === "ready", first);
  const facts = store.listProfileFacts(workspaceId);
  const projects = store.listProjects(workspaceId);
  say("profile", { facts: facts.length, confirmed: facts.filter((fact) => fact.status === "confirmed").length, projects: projects.map((project) => `${project.identityId}/${project.id}`) });
  check("several_projects_found", projects.length >= 4, projects.map((project) => project.id));
  const batch = store.listEvents(workspaceId, { type: "dates.extracted" }).at(-1);
  const dates = ((batch?.payload as { dates?: unknown[]; recurring?: unknown[] } | undefined)?.dates ?? []).length;
  const items = ((batch?.payload as { dates?: Array<{ title: string; date: string; project?: string; confidence?: string }> } | undefined)?.dates ?? []);
  say("dates", { batchItems: dates, ece555: items.filter((item) => /555/.test(`${item.project ?? ""}${item.title}`) || /quiz|hw|homework|project|final|作业|小测|期末|项目/i.test(item.title)).map((item) => `${item.date} ${item.title}${item.confidence === "low" ? " (low)" : ""}`) });
  check("dates_read_from_files", dates >= 5, dates);

  // 2b. What the app has to ask before it may work backwards from a goal. On the real account these are the person's choices; the throwaway
  // account answers them the way the screen would (the composed `【question】选择：label` message), so the worker writes the facts itself.
  const undated = ((batch?.payload as { undated?: Array<{ project?: string; title: string }> } | undefined)?.undated ?? []);
  say("undated", undated.map((item) => `${item.project}: ${item.title}`));
  check("tbd_items_are_kept_not_lost", undated.some((item) => /project|项目|report/i.test(item.title)), undated);
  const gapsNow = () => profileGaps({
    identities: [{ id: "research", label: "科研" }, { id: "startup", label: "创业" }, { id: "media", label: "自媒体" }, { id: "investment", label: "投资" }],
    projects: store.listProjects(workspaceId).map(({ id, identityId, name }) => ({ id, identityId, name })),
    facts: store.listProfileFacts(workspaceId), undated: latestFileDates(store, workspaceId).undated
  });
  const before = gapsNow();
  say("gaps", before.map((gap) => `${gap.code}:${gap.projectId || gap.identityId}`));
  check("no_target_is_asked_up_front", !before.some((gap) => (gap.code as string) === "TARGET_GRADE_MISSING"), before.map((gap) => gap.code));
  const pick = (gap: (typeof before)[number]) => gap.code === "LINE_UNCONFIRMED" ? "目前没有在做的事" : gap.question.options.at(-1)!.label;
  if (before.length) {
    const answered = await interview({ sessionId: "journey", text: before.map((gap) => `【${gap.question.text}】选择：${pick(gap)}`).join("\n") });
    say("gaps_answered", { state: answered.state, left: gapsNow().filter((gap) => gap.blocking).map((gap) => `${gap.code}:${gap.projectId || gap.identityId}`) });
    check("answers_become_facts", !gapsNow().some((gap) => gap.blocking), gapsNow().map((gap) => gap.code));
  }

  // 3. Milestone drafts.
  const propose = createMilestoneProposer(store, workspaceId, repoRoot, getClient);
  const proposed = await propose("");
  say("milestones", proposed.state === "proposed" ? { drafts: proposed.drafts.map((draft) => `${draft.identityId}: ${draft.title}`) } : proposed);
  check("milestones_proposed", proposed.state === "proposed", proposed.state === "blocked" ? proposed : undefined);
  const drafts = store.listMilestones(workspaceId).filter((milestone) => milestone.status === "draft");
  const covered = new Set(drafts.map((milestone) => milestone.projectId));
  // The check that was false on the real account: four research projects, milestones for one.
  const required = projects.filter((project) => facts.filter((fact) => fact.projectId === project.id && fact.status === "confirmed").length >= 3);
  check("every_specific_project_has_a_milestone", required.every((project) => covered.has(project.id)), { required: required.map((project) => project.id), covered: [...covered] });
  say("measurable", drafts.map((milestone) => ({ title: milestone.title, criteria: (milestone.successCriteria ?? []).map((criterion) => `${criterion.measure.kind}:${criterion.statement.slice(0, 40)}`) })).filter((entry) => /555|548|考试|期末|期中|小测|作业/.test(entry.title)));
  const targetFact = store.listProfileFacts(workspaceId, { projectId: "ece555" }).find((fact) => fact.slot === "target_grade")
    ?? store.listProfileFacts(workspaceId).find((fact) => fact.slot === "target_grade");
  say("target", targetFact ? { project: targetFact.projectId, status: targetFact.status, value: targetFact.value } : null);
  check("target_is_proposed_from_goals_and_editable", Boolean(targetFact) && targetFact!.status === "inferred" && /暂定/.test(targetFact!.value), targetFact);
  const relations = store.listMilestoneRelations(workspaceId).filter((relation) => relation.status === "candidate");
  say("relations", relations.map((relation) => `${relation.fromMilestoneId.slice(-6)} -${relation.kind}-> ${relation.toMilestoneId.slice(-6)}: ${relation.explanation}`));
  check("cross_line_relations_proposed", relations.length >= 2, relations.length);

  // 4. The test account approves what it was given. (On a real account this is the person's call, never ours.)
  for (const draft of drafts) store.saveMilestone({ ...draft, version: draft.version + 1, status: "approved" });
  const captureId = "journey-capture";
  store.capture({ id: captureId, ownerId: principal.id, workspaceId, title: "熟悉 Cadence Virtuoso 的使用，并构建一个 6T SRAM 单元（与 ECE 555 的 Cadence/SRAM 内容合并规划）", context: "" }, "journey:capture");
  check("capture_is_picked_up_on_its_own", capturesAwaitingAutoAnalysis(store, workspaceId).includes(captureId));

  // 5. The task they are actually blocked on.
  const analyzed = await createCaptureAnalyzer(store, workspaceId, repoRoot)(supervisor.client, captureId);
  say("analysis", { state: analyzed.state, repairs: analyzed.audit.repairs ?? 0, blocker: analyzed.audit.blocker ?? null });
  check("analysis_reaches_approval", analyzed.state === "awaiting_plan_approval", analyzed.audit.blocker);
  const order = store.listWorkOrders(workspaceId).find((item) => item.id === captureId);
  if (order) {
    const bound = store.listMilestones(workspaceId).find((milestone) => milestone.id === order.milestoneId);
    say("task", { line: order.identityId, project: order.projectId, milestone: bound?.title ?? "(none)", intent: order.intent,
      estimate: order.estimate, breakdown: (order.payload as { estimateBreakdown?: Array<{ step: string; minutes: number }> }).estimateBreakdown, material: (order.payload as { materialContract?: Array<{ description: string }> }).materialContract?.map((item) => item.description) });
    check("task_files_under_a_real_line", ["research", "startup", "media", "investment"].includes(order.identityId), order.identityId);
    check("task_belongs_to_a_project_that_exists", !order.projectId || projects.some((project) => project.id === order.projectId), order.projectId);
  }
} finally {
  await supervisor.stop();
  store.close();
}

console.info(JSON.stringify({ status: failures.length ? "journey_failed" : "journey_passed", failures, dataDir, totalMinutes: Math.round((Date.now() - startedAt) / 6000) / 10 }));
process.exitCode = failures.length ? 1 : 0;
