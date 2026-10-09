/**
 * Does the interview itself draw out what Crossline needs? (asked 2026-10-08: the real account's interview was fed a profile the person
 * had already organised, so it never showed whether the interview leads — and it skipped stages and never asked when ECE 548 meets.)
 *
 *   pnpm exec tsx scripts/onboarding-eval.ts [persona.md] [--turns 20]
 *
 * A throwaway database and a fresh account. The person is played by Skill `crossline-eval-persona` from a hidden persona sheet (default:
 * the person's own profile under `data/profile/`, never committed): it answers only what it is asked, never volunteers, uploads a file only
 * when asked for one. The interview runs as it does for a real new user, from an empty first message, until it says it is done or the turn
 * limit. Dates it reads are confirmed as a person would; nothing else is answered for them. The report scores the interview against its
 * own completion list (`interviewChecklistFor`, the interview's items only — the person's own clicks are not the interview's to earn),
 * per course and project, and prints turns, questions and minutes. It spends real quota and takes hours; it is never run as a side effect.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runCodexSkill, setUsageSink, startCodexSupervisor } from "../packages/codex/src/index";
import { CrosslineStore, interviewChecklistFor } from "../packages/db/src/index";
import { composeAnswers, type Question } from "../apps/web/app/onboarding/onboarding-types";
import { extractText, sha256 } from "../apps/worker/src/extract";
import { identityLines } from "../apps/worker/src/lines";
import { createOnboardingSessionRunner } from "../apps/worker/src/onboarding-session";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const turnLimit = Number(args[args.indexOf("--turns") + 1]) || 20;
const personaFile = args.find((arg) => arg.endsWith(".md")) ?? path.join(repoRoot, "data", "profile", "karolyan1215.profile.md");
if (!existsSync(personaFile)) throw new Error(`persona sheet not found: ${personaFile}`);
const persona = readFileSync(personaFile, "utf8").replace(/^>.*$/gm, "").slice(0, 12_000);

const dataDir = mkdtempSync(path.join(tmpdir(), "crossline-onboarding-eval-"));
const store = new CrosslineStore(path.join(dataDir, "crossline.db"));
const { workspace, principal } = store.createPrincipalWithWorkspace("onboarding-eval", "eval");
const workspaceId = workspace.id;
// What the person set on the opening screen before the interview: the identity nouns, the base line and the hard constraint — no goals.
store.setSetting(workspaceId, "lines.v1", JSON.stringify([
  { id: "research", label: "研究者", color: "research", goal: "", createdAt: "", rank: 1, hard: true },
  { id: "startup", label: "创业者", color: "startup", goal: "", createdAt: "" },
  { id: "media", label: "创作者", color: "media", goal: "", createdAt: "" },
  { id: "investment", label: "投资者", color: "investment", goal: "", createdAt: "" }]));
const startedAt = Date.now();
let runs = 0, repairs = 0;
setUsageSink((usage) => { runs += 1; repairs += usage.repairs ?? 0; });

// Files the person has on their machine and would upload when asked (not the organised profile: that is the hidden truth).
const downloads = path.join(homedir(), "Downloads");
const available = new Map([
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

/** A person confirming the dates the interview read (what the date card's 确认 does), so the checklist is not held by a click. */
function confirmDates() {
  const decided = new Set(store.listEvents(workspaceId, { type: "dates.decided" }).map((event) => event.entityId));
  for (const event of store.listEvents(workspaceId, { type: "dates.extracted" }).filter((item) => !decided.has(item.entityId))) {
    const payload = event.payload as { dates?: Array<{ id: string }>; recurring?: Array<{ id: string }> };
    store.appendEvent({ ownerId: principal.id, workspaceId, idempotencyKey: `eval:decided:${event.entityId}`, type: "dates.decided", entityId: event.entityId,
      payload: { included: [...(payload.dates ?? []), ...(payload.recurring ?? [])].map((item) => item.id), excluded: [], blocks: 0 } });
  }
}

const supervisor = await startCodexSupervisor({
  port: Number(process.env.CROSSLINE_CODEX_SUPERVISOR_PORT ?? 3398),
  plugin: { name: "crossline", marketplacePath: path.join(repoRoot, "skills", "marketplace", ".agents", "plugins", "marketplace.json"), cwd: repoRoot,
    requiredSkills: ["crossline:crossline-onboarding", "crossline:crossline-eval-persona"] }
});
const client = supervisor.client;
const interview = createOnboardingSessionRunner(store, workspaceId, repoRoot, () => client);
const PERSONA_SCHEMA = { type: "object", additionalProperties: false, required: ["answers", "freeText", "upload"], properties: {
  answers: { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false, required: ["questionId", "picked", "other"], properties: {
    questionId: { type: "string", minLength: 1, maxLength: 120 }, picked: { type: "array", maxItems: 6, items: { type: "string", minLength: 1, maxLength: 200 } },
    other: { type: "string", minLength: 0, maxLength: 400 } } } },
  freeText: { type: "string", minLength: 0, maxLength: 600 }, upload: { type: "array", maxItems: 4, items: { type: "string", minLength: 1, maxLength: 200 } } } };
type PersonaAnswer = { answers: Array<{ questionId: string; picked: string[]; other: string }>; freeText: string; upload: string[] };

const transcript: string[] = [];
let text = "你好，我想开始。";
let turns = 0, questionsAsked = 0, state = "";
try {
  while (turns < turnLimit) {
    turns += 1;
    const outcome = await interview({ sessionId: "eval", text });
    state = outcome.state;
    if (outcome.state === "blocked") { transcript.push(`第 ${turns} 轮：中断 ${outcome.code} ${outcome.message}`); break; }
    confirmDates();
    const last = store.listOnboardingMessages(workspaceId, "eval").at(-1)!;
    const turn = last.content as { reply: string; questions: Question[]; stage?: string; nextAction: string };
    questionsAsked += turn.questions.length;
    transcript.push(`### 第 ${turns} 轮（${turn.stage ?? ""}）\n\n${turn.reply}\n\n${turn.questions.map((question, index) => `${index + 1}. ${question.text}`).join("\n")}`);
    console.info(JSON.stringify({ turn: turns, stage: turn.stage, questions: turn.questions.length, next: turn.nextAction, minutes: Math.round((Date.now() - startedAt) / 60_000) }));
    if (outcome.state === "ready") break;
    const context = { version: "crossline.eval-persona.v1", persona, reply: turn.reply,
      questions: turn.questions.map(({ id, text: body, kind, options }) => ({ id, text: body, kind, options: options.map((option) => ({ label: option.label })) })),
      files: [...available.keys()] };
    const played = await runCodexSkill<PersonaAnswer>(client, context, { skillName: "crossline:crossline-eval-persona", cwd: repoRoot,
      developerInstructions: "Play the person as the Skill describes. Return raw JSON only.", outputSchema: PERSONA_SCHEMA, prepareInput: () => context,
      validateOutput: (output) => output as PersonaAnswer, onAudit: () => {}, timeoutMs: 30 * 60_000 });
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
} finally {
  const lines = identityLines(store, workspaceId).map((line) => ({ id: line.id, label: line.label, hard: Boolean(line.hard), goals: line.goals ?? [] }));
  const checklist = interviewChecklistFor(store, workspaceId, lines, { unfiledFiles: null });
  const own = checklist.filter((item) => item.owner === "interview");
  const minutes = Math.round((Date.now() - startedAt) / 60_000);
  const report = [
    `# 访谈评测 · ${new Date().toISOString().slice(0, 16)}`, "",
    `- 模拟用户：${path.basename(personaFile)}（只答所问，不主动交代）`,
    `- 结束状态：${state}；${turns} 轮，${questionsAsked} 个问题，${minutes} 分钟；模型调用 ${runs} 次，修复 ${repairs} 次`,
    `- 访谈自身的清单项：完成 ${own.filter((item) => item.done).length}/${own.length}`, "",
    "| 清单项 | 结果 | 缺 |", "|---|---|---|",
    ...own.map((item) => `| ${item.label} | ${item.done ? "✓" : "✗"} | ${item.done ? "" : item.detail} |`), "",
    `项目：${store.listProjects(workspaceId).map((project) => project.name).join("、") || "无"}`,
    `已确认事实：${store.listProfileFacts(workspaceId).filter((fact) => fact.status === "confirmed").length} 条`, "",
    "## 对话", "", ...transcript
  ].join("\n");
  const out = path.join(repoRoot, "data", "eval");
  mkdirSync(out, { recursive: true });
  const file = path.join(out, `onboarding-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  writeFileSync(file, report);
  console.info(JSON.stringify({ report: file, interviewItems: `${own.filter((item) => item.done).length}/${own.length}`, turns, minutes }));
  await supervisor.stop();
  store.close();
}
