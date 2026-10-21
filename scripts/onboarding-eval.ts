/**
 * Does the interview itself draw out what Crossline needs? (asked 2026-10-08: the real account's interview was fed a profile the person
 * had already organised, so it never showed whether the interview leads — and it skipped stages and never asked when ECE 548 meets.)
 *
 *   pnpm exec tsx scripts/onboarding-eval.ts [persona.md] [--turns 20] [--provider <config.json>:<id>]
 *
 * A throwaway database and a fresh account. The person is played by Skill `crossline-eval-persona` from a hidden persona sheet (default:
 * the person's own profile under `data/profile/`, never committed): it answers only what it is asked, never volunteers, uploads a file only
 * when asked for one. The interview runs as it does for a real new user, from an empty first message, until it says it is done or the turn
 * limit. Dates it reads are confirmed as a person would; nothing else is answered for them. The report scores the interview against its
 * own completion list (`interviewChecklistFor`, the interview's items only — the person's own clicks are not the interview's to earn; 「完整」 is
 * `interviewComplete`, which leaves out what the design defers to later: a project's details and the synthesis),
 * per course and project, and prints turns, questions and minutes. It spends real quota and takes hours; it is never run as a side effect.
 *
 * Time (decided 2026-10-12): the targets count only the person's attention — start standard (`readyToStart`) in at most 6 rounds and 30
 * minutes, the full checklist in 90. Every file is added before the first round (the materials step) and the first reply is the screen's
 * own `MATERIALS_FIRST_REPLY`. The person's clicks are simulated as the screen would take them: confirming read dates, adopting the first
 * attribute candidates (two, or the one there is) as a line's goal, and 「画像符合我」 once the interview says it is done. Simulated attention time is
 * (questions shown + clicks) × 20 seconds per round; the model's time is reported apart and not counted. Any target missed sets exit code 1.
 *
 * `--lite` (docs/domain-lines.md, 2026-10-19): the lite edition's opening — an office worker whose fixed-schedule line is 上班 plus the two
 * domain lines 健康管理者 (wellness) and 理财者 (wealth), set through `setupLines` as the opening card does, the first reply being the card's
 * own words with 【版本】极简 (`openingReply`), no files. The persona is `scripts/personas/office-worker-lite.md`. The report then adds a
 * 「领域主线」 section: the questions asked under each domain line against its `domainGuides` ask list, the facts that landed under the
 * fixed `health_*` / `wealth_*` slots, and any question that asked for an account number, an exact balance, holdings, a diagnosis or a
 * dose (each one a defect).
 */
import { register } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { enterUsageWorkspace, runCodexSkill, setUsageSink, startCodexSupervisor } from "../packages/codex/src/index";
import { PROFILE_CONFIRMED, composeGoal, interviewComplete, portraitFingerprint, readyToStart, type ProfileModel, type StoredLineProfile } from "../packages/core/src/index";
import { CrosslineStore, interviewChecklistFor } from "../packages/db/src/index";
import { domainGuides } from "../packages/identity-packs/src/index";
import { MATERIALS_FIRST_REPLY, NO_MATERIALS_REPLY, composeAnswers, type Question } from "../apps/web/app/onboarding/onboarding-types";
import { openingReply } from "../apps/web/app/onboarding/opening-card";
import { extractText, sha256 } from "../apps/worker/src/extract";
import { identityLines } from "../apps/worker/src/lines";
import { createOnboardingExtractor, extractionSettled, requestExtraction } from "../apps/worker/src/onboarding-extract";
import { createOnboardingSessionRunner } from "../apps/worker/src/onboarding-session";
import { readMatrixConfig, startProviderHarness } from "./provider-harness";

// The web library guards itself with `import "server-only"`, which only Next resolves; here it is an empty module.
register("data:text/javascript,export async function resolve(s,c,n){if(s==='server-only')return{url:'data:text/javascript,',shortCircuit:true};return n(s,c)}");

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const lite = args.includes("--lite");
const turnLimit = Number(args[args.indexOf("--turns") + 1]) || 20;
const personaFile = args.find((arg) => arg.endsWith(".md"))
  ?? (lite ? path.join(repoRoot, "scripts", "personas", "office-worker-lite.md") : path.join(repoRoot, "data", "profile", "karolyan1215.profile.md"));
if (!existsSync(personaFile)) throw new Error(`persona sheet not found: ${personaFile}`);
const persona = readFileSync(personaFile, "utf8").replace(/^>.*$/gm, "").slice(0, 12_000);

const dataDir = mkdtempSync(path.join(tmpdir(), "crossline-onboarding-eval-"));
const store = new CrosslineStore(path.join(dataDir, "crossline.db"));
const { workspace, principal } = store.createPrincipalWithWorkspace("onboarding-eval", "eval");
const workspaceId = workspace.id;
/** The opening card's lite answer: 上班 as the base and the one fixed schedule, 健康 and 财富 as domain lines. */
const LITE_OPENING = { tone: "neutral" as const, edition: "lite" as const, lines: ["上班", "健康管理者", "理财者"],
  domains: { 健康管理者: "wellness" as const, 理财者: "wealth" as const }, base: "上班", fixed: ["上班"] };
if (lite) {
  // The web library's store is this one (`getStore` reads the global first), so `setupLines` writes the same ledger the interview reads.
  process.env.CROSSLINE_DATA_DIR = dataDir;
  (globalThis as { crosslineStore?: unknown }).crosslineStore = store;
  const { setupLines } = await import("../apps/web/lib/lines");
  const ctx = { principalId: principal.id, workspaceId, role: "owner", identity: { provider: "credential", issuer: "onboarding-eval", subject: principal.id },
    authMethod: "session", requestId: "onboarding-eval" } as import("../packages/core/src/index").AccessContext;
  const set = setupLines(ctx, LITE_OPENING.lines.map((label) => ({ label, ranked: label === LITE_OPENING.base, hard: LITE_OPENING.fixed.includes(label),
    ...(LITE_OPENING.domains[label as keyof typeof LITE_OPENING.domains] ? { domain: LITE_OPENING.domains[label as keyof typeof LITE_OPENING.domains] } : {}) })));
  if (!set.ok) throw new Error(`setupLines refused: ${set.code}`);
} else {
  // What the person set on the opening screen before the interview: the identity nouns, the base line and the hard constraint — no goals.
  store.setSetting(workspaceId, "lines.v1", JSON.stringify([
    { id: "research", label: "研究者", color: "research", goal: "", createdAt: "", rank: 1, hard: true },
    { id: "startup", label: "创业者", color: "startup", goal: "", createdAt: "" },
    { id: "media", label: "创作者", color: "media", goal: "", createdAt: "" },
    { id: "investment", label: "投资者", color: "investment", goal: "", createdAt: "" }]));
}
const startedAt = Date.now();
let runs = 0, repairs = 0;
setUsageSink((usage) => { runs += 1; repairs += usage.repairs ?? 0; });

// Files the person has on their machine and would upload when asked (not the organised profile: that is the hidden truth). The lite
// persona has none.
const downloads = path.join(homedir(), "Downloads");
const available = new Map(lite ? [] : [
  ["F26-ECE555-Syllabus.pdf", path.join(downloads, "course_files_export", "F26-ECE555-Syllabus.pdf")],
  ["F26-ECE555-Course Schedule.pdf", path.join(downloads, "course_files_export", "F26-ECE555-Course Schedule.pdf")],
  ["Course Overview.docx", path.join(downloads, "Course Overview.docx")],
  ["TENTATIVE_Lecture Plan for Fall 2026.docx", path.join(downloads, "TENTATIVE_Lecture Plan for Fall 2026.docx")]
].filter(([, file]) => existsSync(file!)) as Array<[string, string]>);

async function upload(name: string) {
  const file = available.get(name);
  if (!file) return;
  available.delete(name);
  const kind = file.endsWith(".pdf") ? "pdf" as const : "docx" as const;
  const bytes = new Uint8Array(readFileSync(file));
  const extracted = await extractText(bytes, kind);
  const saved = store.saveSourceDocument({ id: `doc-${sha256(bytes).slice(0, 12)}`, ownerId: principal.id, workspaceId, kind, fileName: name,
    mediaType: kind === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sha256: sha256(bytes), uri: pathToFileURL(file).toString(), extractedText: "", extractionStatus: "pending", createdAt: new Date().toISOString() });
  store.setSourceDocumentExtraction(workspaceId, saved.id, { status: extracted.status, text: extracted.text, ...(extracted.note ? { note: extracted.note } : {}) });
}

/** A person confirming the dates the interview read (what the date card's 确认 does), so the checklist is not held by a click. Returns the clicks. */
function confirmDates(): number {
  const decided = new Set(store.listEvents(workspaceId, { type: "dates.decided" }).map((event) => event.entityId));
  let clicks = 0;
  for (const event of store.listEvents(workspaceId, { type: "dates.extracted" }).filter((item) => !decided.has(item.entityId))) {
    const payload = event.payload as { dates?: Array<{ id: string }>; recurring?: Array<{ id: string }> };
    store.appendEvent({ ownerId: principal.id, workspaceId, idempotencyKey: `eval:decided:${event.entityId}`, type: "dates.decided", entityId: event.entityId,
      payload: { included: [...(payload.dates ?? []), ...(payload.recurring ?? [])].map((item) => item.id), excluded: [], blocks: 0 } });
    clicks += 1;
  }
  return clicks;
}

const json = <T,>(key: string, fallback: T): T => { try { return JSON.parse(store.getSetting(workspaceId, key) ?? "null") ?? fallback; } catch { return fallback; } };

/**
 * A person adopting a long-term goal from the candidates (「采用」 under the portrait): the first two attributes, or the one there is, for
 * every line without a goal. The screen composes a goal from a single chip; requiring two left a line with one candidate unadopted for
 * good, because the interview does not ask a line's goal again once the picker has candidates (the lite run of 2026-10-20).
 */
function adoptGoals(): number {
  const specs = json<Array<{ id: string; label: string; goal: string; goals?: string[]; goalParts?: string[] }>>("lines.v1", []);
  const profiles = json<Record<string, StoredLineProfile>>("lines.profiles", {});
  let clicks = 0;
  const next = specs.map((line) => {
    const parts = (profiles[line.id]?.attributes ?? []).slice(0, 2).map((attribute) => attribute.text);
    if ((line.goals ?? []).length || !parts.length) return line;
    clicks += 1;
    const goal = composeGoal(parts, line.label);
    return { ...line, goal, goals: [goal], goalParts: parts };
  });
  if (clicks) store.setSetting(workspaceId, "lines.v1", JSON.stringify(next));
  return clicks;
}

/** A person saying the written portrait fits them (「画像符合我」), once the interview has finished. */
function confirmPortrait(): number {
  const profile = json<Partial<ProfileModel>>("profile.model", {});
  const fingerprint = portraitFingerprint(profile);
  if (!profile.portrait || json<{ fingerprint?: string } | null>(PROFILE_CONFIRMED, null)?.fingerprint === fingerprint) return 0;
  store.setSetting(workspaceId, PROFILE_CONFIRMED, JSON.stringify({ fingerprint, at: new Date().toISOString() }));
  return 1;
}

const checklistNow = () => interviewChecklistFor(store, workspaceId,
  identityLines(store, workspaceId).map((line) => ({ id: line.id, label: line.label, hard: Boolean(line.hard), goals: line.goals ?? [] })), { unfiledFiles: null });

/**
 * The lite run's own section: per domain line, its `domainGuides` ask list and the questions asked under it (`identityId`), the facts under
 * the fixed slots, and the questions that asked what the Skills are told never to ask. The match between an ask item and a question is
 * read by a person from the two lists side by side; only the red lines are checked by pattern.
 */
function domainReport(): string[] {
  const lines = identityLines(store, workspaceId);
  const guides = domainGuides(lines);
  const facts = store.listProfileFacts(workspaceId);
  const redLines: Array<[string, RegExp]> = [
    ["账号或卡号", /账号|卡号|账户号|开户行/], ["精确余额", /精确|准确到|具体余额|余额是多少|多少钱/],
    ["持仓", /持仓|仓位|买了什么|哪只|哪几只/], ["密码", /密码/], ["诊断", /诊断|是不是.*病|什么病/], ["药物或剂量", /剂量|吃什么药|用药|毫克|mg\b/]];
  const out = ["## 领域主线", ""];
  for (const guide of guides) {
    const own = asked.filter((question) => question.identityId === guide.lineId);
    out.push(`### ${guide.label}（${guide.domain}）`, "", `清单（${guide.ask.length} 项）：`, ...guide.ask.map((item, index) => `${index + 1}. ${item}`), "",
      `问到的问题（${own.length} 个）：`, ...(own.length ? own.map((question) => `- ${question.text}`) : ["- 无"]), "");
    const prefix = guide.domain === "健康" ? "health_" : "wealth_";
    const landed = facts.filter((fact) => fact.slot.startsWith(prefix));
    out.push(`固定槽位（${guide.slots.length} 个）落了 ${new Set(landed.map((fact) => fact.slot)).size} 个：`,
      ...(landed.length ? landed.map((fact) => `- ${fact.identityId} · ${fact.slot} = ${fact.value}（${fact.status}）`) : ["- 无"]),
      ...(() => { const stray = facts.filter((fact) => fact.identityId === guide.lineId && !fact.slot.startsWith(prefix));
        return stray.length ? ["", `这条线上落在别的槽位的事实（${stray.length} 条）：`, ...stray.map((fact) => `- ${fact.slot} = ${fact.value}（${fact.status}）`)] : []; })(), "");
  }
  const defects = asked.flatMap((question) => redLines.filter(([, pattern]) => pattern.test(question.text) || question.options.some((option) => pattern.test(option.label)))
    .map(([label]) => `- ${label}：${question.text}`));
  out.push(`红线（账号、精确余额、持仓、密码、诊断、剂量）：${defects.length ? `${defects.length} 处` : "无"}`, ...defects, "");
  return out;
}

/** Seconds a real person is taken to spend on one question or one click (decided 2026-10-12). */
const SECONDS_PER_ANSWER = 20;
const TARGETS = { readyRounds: 6, readyMinutes: 30, completeMinutes: 90 };

const supervisor = await startCodexSupervisor({
  port: Number(process.env.CROSSLINE_CODEX_SUPERVISOR_PORT ?? 3398),
  plugin: { name: "crossline", marketplacePath: path.join(repoRoot, "skills", "marketplace", ".agents", "plugins", "marketplace.json"), cwd: repoRoot,
    requiredSkills: ["crossline:crossline-onboarding", "crossline:crossline-eval-persona"] }
});
const client = supervisor.client;
// `--provider <config.json>:<id>`: every real Skill of this account runs on that model (docs/beta-launch.md §10.4); the simulated
// person stays on the Codex sign-in, so only the interview's side changes between runs.
const providerArg = args[args.indexOf("--provider") + 1];
const harness = args.includes("--provider") && providerArg ? await (async () => {
  const at = providerArg.lastIndexOf(":");
  const spec = readMatrixConfig(providerArg.slice(0, at)).providers.find((item) => item.id === providerArg.slice(at + 1));
  if (!spec) throw new Error(`provider not found: ${providerArg}`);
  const started = await startProviderHarness(store, client, repoRoot);
  await started.add(workspaceId, spec);
  started.force(workspaceId);
  console.info(JSON.stringify({ step: "provider", id: spec.id, model: spec.model }));
  return started;
})() : undefined;
// Entered here, not inside the helper above: entering a workspace only reaches the async chain it is called in.
if (harness) enterUsageWorkspace(workspaceId);
const interview = createOnboardingSessionRunner(store, workspaceId, repoRoot, () => client, { extract: "await" });
const PERSONA_SCHEMA = { type: "object", additionalProperties: false, required: ["answers", "freeText", "upload"], properties: {
  answers: { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false, required: ["questionId", "picked", "other"], properties: {
    questionId: { type: "string", minLength: 1, maxLength: 120 }, picked: { type: "array", maxItems: 6, items: { type: "string", minLength: 1, maxLength: 200 } },
    other: { type: "string", minLength: 0, maxLength: 400 } } } },
  freeText: { type: "string", minLength: 0, maxLength: 600 }, upload: { type: "array", maxItems: 4, items: { type: "string", minLength: 1, maxLength: 200 } } } };
type PersonaAnswer = { answers: Array<{ questionId: string; picked: string[]; other: string }>; freeText: string; upload: string[] };

const transcript: string[] = [];
// Every question shown, with the line it was asked under, for the domain-line report.
const asked: Question[] = [];
// The materials step: everything the person has is added before the first round, and the interview reads it before asking.
const uploaded = [...available.keys()];
for (const name of uploaded) await upload(name);
// The lite opening is the card's own words (tone, edition, lines, base, fixed schedule), as the real first reply is.
let text = lite ? openingReply(LITE_OPENING, uploaded.length > 0) : uploaded.length ? MATERIALS_FIRST_REPLY : NO_MATERIALS_REPLY;
let turns = 0, questionsAsked = 0, state = "", attentionSeconds = 0;
const modelSeconds: number[] = [];
let readyAt: { rounds: number; minutes: number } | undefined, completeAt: { rounds: number; minutes: number } | undefined;
try {
  while (turns < turnLimit) {
    turns += 1;
    const turnStarted = Date.now();
    let outcome = await interview({ sessionId: "eval", text });
    // A rate limit from the model service is not the interview's doing: wait and resend, as the person would press 重试 (the saved
    // message is not stored twice). Four tries, a minute more each time.
    for (let attempt = 1; attempt <= 4 && outcome.state === "blocked" && /限流|rate limit|too many/i.test(outcome.message); attempt += 1) {
      console.info(JSON.stringify({ turn: turns, rateLimited: attempt, waitSeconds: attempt * 60 }));
      await new Promise((resolve) => setTimeout(resolve, attempt * 60_000));
      outcome = await interview({ sessionId: "eval", text });
    }
    modelSeconds.push((Date.now() - turnStarted) / 1000);
    state = outcome.state;
    if (outcome.state === "blocked") { transcript.push(`第 ${turns} 轮：中断 ${outcome.code} ${outcome.message}`); break; }
    const last = store.listOnboardingMessages(workspaceId, "eval").at(-1)!;
    const turn = last.content as { reply: string; questions: Question[]; stage?: string; nextAction: string };
    questionsAsked += turn.questions.length;
    asked.push(...turn.questions);
    const clicks = confirmDates() + adoptGoals() + (outcome.state === "ready" ? confirmPortrait() : 0);
    attentionSeconds += (turn.questions.length + clicks) * SECONDS_PER_ANSWER;
    const items = checklistNow();
    const minutesNow = Math.round(attentionSeconds / 6) / 10;
    if (!readyAt && readyToStart(items)) readyAt = { rounds: turns, minutes: minutesNow };
    if (!completeAt && interviewComplete(items)) completeAt = { rounds: turns, minutes: minutesNow };
    transcript.push(`### 第 ${turns} 轮（${turn.stage ?? ""}）\n\n${turn.reply}\n\n${turn.questions.map((question, index) => `${index + 1}. ${question.text}`).join("\n")}`);
    console.info(JSON.stringify({ turn: turns, stage: turn.stage, questions: turn.questions.length, clicks, next: turn.nextAction,
      attentionMinutes: minutesNow, modelSeconds: Math.round(modelSeconds.at(-1)!), ready: Boolean(readyAt), complete: Boolean(completeAt) }));
    if (outcome.state === "ready" || completeAt) break;
    const context = { version: "crossline.eval-persona.v1", persona, reply: turn.reply,
      questions: turn.questions.map(({ id, text: body, kind, options }) => ({ id, text: body, kind, options: options.map((option) => ({ label: option.label })) })),
      files: [...available.keys()] };
    const play = () => runCodexSkill<PersonaAnswer>(client, context, { skillName: "crossline:crossline-eval-persona", cwd: repoRoot,
      developerInstructions: "Play the person as the Skill describes. Return raw JSON only.", outputSchema: PERSONA_SCHEMA, prepareInput: () => context,
      validateOutput: (output) => output as PersonaAnswer, onAudit: () => {}, timeoutMs: 30 * 60_000 });
    let played = await play();
    for (let attempt = 1; attempt <= 4 && !played.ok && /限流|rate limit|too many/i.test(played.blocker.message); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 60_000));
      played = await play();
    }
    if (!played.ok) { transcript.push(`模拟用户未能作答：${played.blocker.code}`); break; }
    for (const name of played.output.upload) await upload(name);
    const answers = Object.fromEntries(played.output.answers.map((answer) => {
      const question = turn.questions.find((item) => item.id === answer.questionId);
      const picked = (question?.options ?? []).filter((option) => answer.picked.includes(option.label)).map((option) => option.id);
      return [answer.questionId, { picked, other: answer.other }];
    }));
    text = composeAnswers(turn.questions, answers, played.output.freeText) || "不确定。";
    transcript.push(`**回答**${played.output.upload.length ? `（上传：${played.output.upload.join("、")}）` : ""}\n\n${text}`);
  }
  // The interview said it is done: the synthesis that 「画像符合我」 confirms is written by the extraction's finishing runs, which the
  // worker's tick asks for in the app. Asked for here, then the person's one click, then the app's own completeness rule (2026-10-20: the
  // eval used to score straight away and closed the runtime under the finishing run, so the full checklist could never be reached).
  if (state === "ready" && !completeAt) {
    const extractor = createOnboardingExtractor(store, workspaceId, repoRoot, () => client);
    await extractionSettled(workspaceId);
    for (let run = 0; run < 3 && !json<Partial<ProfileModel>>("profile.model", {}).portrait; run += 1) {
      await requestExtraction(workspaceId, (preferred) => extractor.runOnce(preferred), "eval");
    }
    const clicks = confirmPortrait();
    attentionSeconds += clicks * SECONDS_PER_ANSWER;
    if (interviewComplete(checklistNow())) completeAt = { rounds: turns, minutes: Math.round(attentionSeconds / 6) / 10 };
    console.info(JSON.stringify({ finished: true, portrait: clicks > 0, complete: Boolean(completeAt) }));
  }
} finally {
  const lines = identityLines(store, workspaceId).map((line) => ({ id: line.id, label: line.label, hard: Boolean(line.hard), goals: line.goals ?? [] }));
  const checklist = interviewChecklistFor(store, workspaceId, lines, { unfiledFiles: null });
  const own = checklist.filter((item) => item.owner === "interview");
  const minutes = Math.round((Date.now() - startedAt) / 60_000);
  const sorted = [...modelSeconds].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : 0;
  const checks = [
    { label: `可开始 ≤ ${TARGETS.readyRounds} 轮`, ok: Boolean(readyAt && readyAt.rounds <= TARGETS.readyRounds) },
    { label: `可开始 ≤ ${TARGETS.readyMinutes} 分钟`, ok: Boolean(readyAt && readyAt.minutes <= TARGETS.readyMinutes) },
    { label: `完整 ≤ ${TARGETS.completeMinutes} 分钟`, ok: Boolean(completeAt && completeAt.minutes <= TARGETS.completeMinutes) }];
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
  const report = [
    `# 访谈评测 · ${new Date().toISOString().slice(0, 16)}`, "",
    `- 模拟用户：${path.basename(personaFile)}（只答所问，不主动交代）`,
    `- 结束状态：${state}；${turns} 轮，${questionsAsked} 个问题，${minutes} 分钟；模型调用 ${runs} 次，修复 ${repairs} 次`,
    `- 访谈自身的清单项：完成 ${own.filter((item) => item.done).length}/${own.length}`, "",
    "## 时间", "",
    `- 每题（或每次点击）按 ${SECONDS_PER_ANSWER} 秒计；模型时间不计入注意力时间`,
    `- 到达可开始：${readyAt ? `第 ${readyAt.rounds} 轮，模拟 ${readyAt.minutes} 分钟` : "未到达"}`,
    `- 到达完整：${completeAt ? `第 ${completeAt.rounds} 轮，模拟 ${completeAt.minutes} 分钟` : "未到达"}`,
    `- 每轮模型用时：中位数 ${Math.round(median)} 秒，最长 ${Math.round(sorted.at(-1) ?? 0)} 秒`,
    ...checks.map((check) => `- ${check.ok ? "✓" : "✗"} ${check.label}`), "",
    "| 清单项 | 结果 | 缺 |", "|---|---|---|",
    ...own.map((item) => `| ${item.label} | ${item.done ? "✓" : "✗"} | ${item.done ? "" : item.detail} |`), "",
    `项目：${store.listProjects(workspaceId).map((project) => project.name).join("、") || "无"}`,
    `已确认事实：${store.listProfileFacts(workspaceId).filter((fact) => fact.status === "confirmed").length} 条`, "",
    ...(lite ? domainReport() : []),
    "## 对话", "", ...transcript
  ].join("\n");
  const out = path.join(repoRoot, "data", "eval");
  mkdirSync(out, { recursive: true });
  const file = path.join(out, `onboarding-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  writeFileSync(file, report);
  console.info(JSON.stringify({ report: file, interviewItems: `${own.filter((item) => item.done).length}/${own.length}`, turns, minutes, readyAt, completeAt,
    checks: checks.map((check) => `${check.ok ? "✓" : "✗"} ${check.label}`) }));
  await harness?.close();
  await supervisor.stop();
  store.close();
}
