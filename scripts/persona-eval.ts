/**
 * Does the interview reach the person's core? (asked 2026-10-31: a walkthrough as three made-up people, on the developer's model, judged
 * against who they really are.) Each person is a hidden core (who they are: temperament, values, what they want, how they work and live —
 * kept outside the repo, read only by the judges) and a first-person sheet of their life and feelings written from it
 * (`scripts/personas/<set>/life-*.md`). The person is played by Skill `crossline-eval-persona` from the sheet alone: it knows how its days
 * go and how things feel, never its own type, and answers the way the sheet's 「作答习惯」 says (the cards with their biases, the long and
 * the short answers). The interviewer never sees the sheet; the player never sees the core; the judges see the core and what the
 * interview wrote, and not the sheet's reasoning.
 *
 *   tsx scripts/persona-eval.ts --set <dir> --out <dir> [--only a,b] [--turns 26] [--model <id>] [--player-model <id>]
 *
 * `<dir>/openings.json` holds each person's opening card ({life, tone, lines, base, fixed}). Every person gets a throwaway ledger of
 * their own and the real path a new account takes: the opening card's lines and tone, the interview (dialogue and extraction, the
 * extraction in the background as the app runs it), the screen's own filtering of the round's questions (what 待决事项 owns, what the
 * ledger already answers) and the app's held questions, the cards and the observation's 准/不准, dates adopted as the page adopts them,
 * the long-term goal adopted from the first two attribute chips; then the extraction's finishing runs and the portrait writer. The people
 * run side by side in one process (one Codex app-server in a throwaway home); the web library's store is swapped around each of its
 * synchronous calls, so no call reads another person's ledger. Everything goes through the model gateway on the developer's key
 * (`CROSSLINE_SPONSOR_*`): the interview on `--model` (default the main model), the player on `--player-model` (default the same).
 *
 * Writes `<out>/<stamp>/<name>/{transcript.md,result.json}` and `<out>/<stamp>/summary.json`. It spends the key and takes hours; never
 * run as a side effect. On the hosted beta it is the `persona` action of .github/workflows/server.yml, and `persona-report` fetches it.
 */
import { register } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { configureModelGate, runCodexSkill, setProviderResolver, setUsageSink, startCodexAppServer, startCodexSupervisor, startModelGateway,
  threadProvider, withUsageWorkspace, type ProviderRouting, type SkillUsage } from "../packages/codex/src/index";
import {
  ONBOARDING_INSIGHTS, ONBOARDING_TONE_SETTING, PROFILE_CLAIMS_SETTING, PROFILE_INSTRUMENTS_SETTING, THIRD_PARTY_CAPABILITIES, cardWordsHead,
  composeGoal, instrumentClaims, instrumentReadings, interviewComplete, parseSponsorModels, readInsightRatings, readInstrumentAnswers, readyToStart,
  scaleAnswerLine, screenQuestions, sponsorSpend, type AccessContext, type OnboardingTone, type ProfileCard, type StoredLineProfile
} from "../packages/core/src/index";
import { CrosslineStore, interviewChecklistFor, questionScreenFor } from "../packages/db/src/index";
import { composeAnswers, type Question } from "../apps/web/app/onboarding/onboarding-types";
import { openingReply } from "../apps/web/app/onboarding/opening-card";
import { identityLines } from "../apps/worker/src/lines";
import { createOnboardingExtractor, extractionSettled, requestExtraction } from "../apps/worker/src/onboarding-extract";
import { readSectionRecords } from "../apps/worker/src/onboarding-persist";
import { createOnboardingSessionRunner } from "../apps/worker/src/onboarding-session";
import { createPortraitWriter } from "../apps/worker/src/portrait-writer";
import { sponsorFromEnv, SPONSOR_PROVIDER_ID } from "../apps/worker/src/sponsor";

// The web library guards itself with `import "server-only"`, which only Next resolves; here it is an empty module.
register("data:text/javascript,export async function resolve(s,c,n){if(s==='server-only')return{url:'data:text/javascript,',shortCircuit:true};return n(s,c)}");

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const arg = (name: string): string | undefined => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined; };
const setDir = arg("set"), outRoot = arg("out");
if (!setDir || !outRoot) { console.error("usage: persona-eval.ts --set <dir> --out <dir> [--only a,b] [--turns 26] [--model <id>] [--player-model <id>]"); process.exit(2); }
const sponsor = sponsorFromEnv();
if (!sponsor) { console.error("CROSSLINE_SPONSOR_API_KEY / CROSSLINE_SPONSOR_MODELS are not set"); process.exit(2); }
const priced = parseSponsorModels(process.env.CROSSLINE_SPONSOR_MODELS);
const model = arg("model") ?? sponsor.mainModel ?? priced[0]!.model;
const playerModel = arg("player-model") ?? model;
for (const item of [model, playerModel]) if (!priced.some((listed) => listed.model === item)) { console.error(`${item} is not in CROSSLINE_SPONSOR_MODELS`); process.exit(2); }
const turnLimit = Number(arg("turns")) || 26;

type Opening = { life: string; tone: OnboardingTone; lines: string[]; base: string; fixed: string[] };
const openings = JSON.parse(readFileSync(path.join(setDir, "openings.json"), "utf8")) as Record<string, Opening>;
const only = (arg("only") ?? "").split(",").map((item) => item.trim()).filter(Boolean);
const names = Object.keys(openings).filter((name) => !only.length || only.includes(name));

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = path.join(outRoot, stamp);
mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(path.join(tmpdir(), "crossline-persona-"));
// Skills and the line library are written beside the Codex home: a throwaway state directory, never the server's.
process.env.CROSSLINE_STATE_DIR = path.join(scratch, "state");
process.env.CROSSLINE_DATA_DIR = path.join(scratch, "data");

// ---- usage, the gateway and the routing: what the worker gives an invited account, the model pinned ----
const SKILLS = ["crossline-onboarding", "crossline-onboarding-extract", "crossline-portrait-writer", "crossline-eval-persona"];
const keyOf = (name: string, role: "interview" | "player") => `persona-eval:${name}:${role}`;
const usageByKey = new Map<string, SkillUsage[]>();
setUsageSink((usage) => { if (usage.workspaceId) usageByKey.set(usage.workspaceId, [...(usageByKey.get(usage.workspaceId) ?? []), usage]); });
// No real person shares this process: the people, their extractions and their players each get a slot.
configureModelGate({ limit: names.length * 3, perTenant: 3, reserve: 0 });
const gateway = await startModelGateway({ resolve: (key) => key.startsWith("persona-eval:")
  ? { kind: "chat", baseUrl: sponsor.baseUrl, responseFormat: "json_object", key: sponsor.key, thinkingControl: true, patient: true } : undefined });
const routing = (key: string, pinned: string): ProviderRouting => {
  const contextK = sponsor.models.find((item) => item.model === pinned)?.contextK;
  return { provider: { id: SPONSOR_PROVIDER_ID, kind: "chat", label: "开发者提供的模型", baseUrl: sponsor.baseUrl, model: pinned, responseFormat: "json_object",
    keyLast4: null, updatedAt: "1970-01-01T00:00:00.000Z", ...(contextK ? { contextK } : {}) },
    gatewayUrl: gateway.urlFor(key, SPONSOR_PROVIDER_ID), admitted: new Set(SKILLS), codexSignedIn: false, capabilities: { ...THIRD_PARTY_CAPABILITIES, webSearch: false } };
};
setProviderResolver((key) => key?.startsWith("persona-eval:") ? routing(key, key.endsWith(":player") ? playerModel : model) : undefined);
const supervisor = await startCodexSupervisor({ port: Number(process.env.CROSSLINE_CODEX_SUPERVISOR_PORT ?? 3392),
  sidecarFactory: () => startCodexAppServer(path.join(scratch, "codex-home")),
  plugin: { name: "crossline", marketplacePath: path.join(repoRoot, "skills", "marketplace", ".agents", "plugins", "marketplace.json"), cwd: repoRoot,
    requiredSkills: SKILLS.map((skill) => `crossline:${skill}`) } });
const client = supervisor.client;

function cost(key: string) {
  const usage = usageByKey.get(key) ?? [];
  const pinned = key.endsWith(":player") ? playerModel : model;
  const tokens = usage.reduce((sum, row) => ({ input: sum.input + row.inputTokens, cached: sum.cached + row.cachedInputTokens, output: sum.output + row.outputTokens,
    reasoning: sum.reasoning + row.reasoningOutputTokens }), { input: 0, cached: 0, output: 0, reasoning: 0 });
  const bySkill: Record<string, { runs: number; repairs: number; seconds: number }> = {};
  for (const row of usage) {
    const entry = bySkill[row.skillName.replace(/^crossline:/, "")] ??= { runs: 0, repairs: 0, seconds: 0 };
    entry.runs += 1; entry.repairs += row.repairs; entry.seconds += Math.round(row.durationMs / 1000);
  }
  const yuan = sponsorSpend(usage.map((row) => ({ model: pinned, inputTokens: row.inputTokens, cachedInputTokens: row.cachedInputTokens, outputTokens: row.outputTokens })), priced);
  return { model: pinned, tokens, bySkill, yuan: Math.round(yuan * 10_000) / 10_000 };
}

// ---- the player ----
const PLAYER_SCHEMA = { type: "object", additionalProperties: false, required: ["answers", "freeText", "upload", "cardTaps", "cardWords", "insight"], properties: {
  answers: { type: "array", maxItems: 16, items: { type: "object", additionalProperties: false, required: ["questionId", "picked", "other"], properties: {
    questionId: { type: "string", minLength: 1, maxLength: 120 }, picked: { type: "array", maxItems: 6, items: { type: "string", minLength: 1, maxLength: 200 } },
    other: { type: "string", minLength: 0, maxLength: 600 } } } },
  freeText: { type: "string", minLength: 0, maxLength: 900 }, upload: { type: "array", maxItems: 4, items: { type: "string", minLength: 1, maxLength: 200 } },
  cardTaps: { type: "array", maxItems: 30, items: { type: "object", additionalProperties: false, required: ["itemId", "score"], properties: {
    itemId: { type: "string", minLength: 1, maxLength: 80 }, score: { type: "integer", minimum: 0, maximum: 5 } } } },
  cardWords: { type: "array", maxItems: 8, items: { type: "object", additionalProperties: false, required: ["cardId", "words"], properties: {
    cardId: { type: "string", minLength: 1, maxLength: 80 }, words: { type: "string", minLength: 0, maxLength: 400 } } } },
  insight: { type: "string", enum: ["fits", "off", ""] } } };
type Played = { answers: Array<{ questionId: string; picked: string[]; other: string }>; freeText: string; upload: string[];
  cardTaps: Array<{ itemId: string; score: number }>; cardWords: Array<{ cardId: string; words: string }>; insight: "fits" | "off" | "" };

/** The cards' part of the reply, as the screen sends it (`cardReplyLines` in profile-cards.tsx, which the worker reads back without a model). */
function cardLines(cards: readonly ProfileCard[], taps: Record<string, number>, words: Record<string, string>): string[] {
  return cards.flatMap((card) => {
    const tapped = card.items.filter((item) => taps[item.id]).map((item) => scaleAnswerLine(item, taps[item.id]!));
    const said = (words[card.id] ?? "").trim().replace(/\s*\n+\s*/g, " ");
    return said ? [...tapped, `${cardWordsHead(card)}${said}`] : tapped;
  });
}

const rateLimited = (message: string) => /限流|rate limit|too many|满载|overload/i.test(message);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runPerson(name: string, opening: Opening) {
  const dir = path.join(out, name);
  mkdirSync(dir, { recursive: true });
  const life = readFileSync(path.join(setDir!, opening.life), "utf8").slice(0, 14_000);
  const store = new CrosslineStore(path.join(scratch, `${name}.db`));
  const { workspace, principal } = store.createPrincipalWithWorkspace(`persona-${name}`, "eval");
  const workspaceId = workspace.id;
  const ctx = { principalId: principal.id, workspaceId, role: "owner", identity: { provider: "credential", issuer: "persona-eval", subject: principal.id },
    authMethod: "session", requestId: `persona-eval-${name}` } as AccessContext;
  // The web library reads the global store first: set for each synchronous call, so a person never reads another's ledger.
  const web = async () => ({ ...(await import("../apps/web/lib/lines")), ...(await import("../apps/web/lib/interview-status")), ...(await import("../apps/web/lib/imported-dates")) });
  const lib = await web();
  const withStore = <T,>(work: () => T): T => { (globalThis as { crosslineStore?: unknown }).crosslineStore = store; return work(); };
  const json = <T,>(key: string, fallback: T): T => { try { return JSON.parse(store.getSetting(workspaceId, key) ?? "null") ?? fallback; } catch { return fallback; } };
  const log = (event: Record<string, unknown>) => console.info(JSON.stringify({ person: name, ...event }));

  // The opening card: tone and lines are written at once, the base first, then sent as the first reply.
  store.setSetting(workspaceId, ONBOARDING_TONE_SETTING, opening.tone);
  const ordered = [opening.base, ...opening.lines.filter((label) => label !== opening.base)];
  const set = withStore(() => lib.setupLines(ctx, ordered.map((label) => ({ label, ranked: label === opening.base, hard: opening.fixed.includes(label) }))));
  if (!set.ok) throw new Error(`${name}: setupLines refused: ${set.code}`);
  const interviewKey = keyOf(name, "interview"), playerKey = keyOf(name, "player");
  const interview = createOnboardingSessionRunner(store, workspaceId, repoRoot, () => client, { extract: "background" });
  const transcript: string[] = [`# ${name} · ${stamp}`, "", `开场卡：语气 ${opening.tone}；主线 ${opening.lines.join("、")}；底座 ${opening.base}；固定日程 ${opening.fixed.join("、") || "无"}`, ""];
  const earlier: Array<{ interviewer: string; me: string }> = [];
  const rounds: Array<Record<string, unknown>> = [];
  let text = openingReply({ tone: opening.tone, edition: "full", lines: ordered, domains: {}, base: opening.base, fixed: opening.fixed }, false);
  let turns = 0, state = "", goalsAdopted = 0;
  const started = Date.now();
  let readyAt: number | undefined;

  /** A person adopting a long-term goal from the chips (「采用」): the first two attributes, or the one there is, for a line with none. */
  const adoptGoals = () => {
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
  };

  try {
    transcript.push("**开场**", "", text, "");
    while (turns < turnLimit) {
      turns += 1;
      const turnStarted = Date.now();
      let outcome = await withUsageWorkspace(interviewKey, () => interview({ sessionId: "eval", text }));
      for (let attempt = 1; attempt <= 4 && outcome.state === "blocked" && rateLimited(outcome.message); attempt += 1) {
        log({ turn: turns, rateLimited: attempt });
        await wait(attempt * 60_000);
        outcome = await withUsageWorkspace(interviewKey, () => interview({ sessionId: "eval", text }));
      }
      state = outcome.state;
      if (outcome.state === "blocked") { transcript.push(`### 第 ${turns} 轮：中断 ${outcome.code} ${outcome.message}`); log({ turn: turns, blocked: outcome.code }); break; }
      const last = store.listOnboardingMessages(workspaceId, "eval").at(-1)!;
      const turn = last.content as { reply: string; questions: Question[]; cards?: ProfileCard[]; insight?: { text?: string }; stage?: string; nextAction: string };
      // What the screen shows of the round (the state route): questions another place owns or the ledger already answers are left out,
      // and the app's own questions not in the round join it.
      const shown = withStore(() => {
        lib.adoptPendingDates(ctx);
        const moved = lib.questionsOwnedElsewhere(ctx, turn.questions);
        for (const item of screenQuestions(turn.questions, questionScreenFor(store, workspaceId)).screened) moved.add(item.question.id);
        const round = turn.questions.filter((question) => !moved.has(question.id));
        const inRound = new Set(turn.questions.map((question) => question.id));
        const status = lib.interviewStatus(ctx);
        return { round, extra: (status.questions as Question[]).filter((question) => !inRound.has(question.id)) };
      });
      const batch = [...shown.round, ...shown.extra];
      const cards = turn.cards ?? [];
      goalsAdopted += adoptGoals();
      const items = interviewChecklistFor(store, workspaceId, identityLines(store, workspaceId).map((line) => ({ id: line.id, label: line.label,
        hard: Boolean(line.hard), goals: line.goals ?? [] })), { unfiledFiles: null });
      if (!readyAt && readyToStart(items)) readyAt = turns;
      transcript.push(`### 第 ${turns} 轮（${turn.stage ?? ""}）`, "", turn.reply, "",
        ...batch.map((question, index) => `${index + 1}. ${question.text}${question.options.length ? `\n   选项：${question.options.map((option) => option.label).join(" / ")}` : ""}`),
        ...(cards.length ? ["", `卡片：${cards.map((card) => `${card.title}（${card.items.length} 题）`).join("、")}`] : []),
        ...(turn.insight?.text ? ["", `洞察：${turn.insight.text}`] : []), "");
      rounds.push({ turn: turns, stage: turn.stage, questions: batch.length, held: shown.extra.length, cards: cards.reduce((sum, card) => sum + card.items.length, 0),
        insight: Boolean(turn.insight?.text), next: turn.nextAction, modelSeconds: Math.round((Date.now() - turnStarted) / 1000) });
      log({ turn: turns, stage: turn.stage, questions: batch.length, cards: cards.length, next: turn.nextAction, ready: Boolean(readyAt) });
      if (outcome.state === "ready") break;

      const context = { version: "crossline.eval-persona.v2", persona: life, reply: turn.reply,
        questions: batch.map(({ id, text: body, kind, options }) => ({ id, text: body, kind, options: options.map((option) => ({ label: option.label })) })),
        files: [], cards: cards.map((card) => ({ id: card.id, title: card.title, items: card.items.map((item) => ({ id: item.id, text: item.text, anchors: item.anchors })) })),
        insight: turn.insight?.text ?? "", earlier: earlier.slice(-3) };
      const play = () => withUsageWorkspace(playerKey, () => runCodexSkill<Played>(client, context, { skillName: "crossline:crossline-eval-persona", cwd: repoRoot,
        // A test-only Skill is never routed to a provider by the rules, so the player names its thread's provider itself.
        provider: threadProvider(routing(playerKey, playerModel), playerModel, "crossline-eval-persona"),
        developerInstructions: "Play the person as the Skill describes. Return raw JSON only.", outputSchema: PLAYER_SCHEMA, prepareInput: () => context,
        validateOutput: (output) => output as Played, onAudit: () => {}, timeoutMs: 30 * 60_000 }));
      let played = await play();
      for (let attempt = 1; attempt <= 4 && !played.ok && rateLimited(played.blocker.message); attempt += 1) { await wait(attempt * 60_000); played = await play(); }
      if (!played.ok) { transcript.push(`模拟用户未能作答：${played.blocker.code} ${played.blocker.message}`); log({ turn: turns, playerBlocked: played.blocker.code }); break; }
      const answer = played.output;
      const answers = Object.fromEntries(answer.answers.map((item) => {
        const question = batch.find((candidate) => candidate.id === item.questionId);
        const picked = (question?.options ?? []).filter((option) => item.picked.includes(option.label)).map((option) => option.id);
        return [item.questionId, { picked, other: item.other }];
      }));
      const itemIds = new Set(cards.flatMap((card) => card.items.map((item) => item.id)));
      const taps = Object.fromEntries(answer.cardTaps.filter((tap) => itemIds.has(tap.itemId) && tap.score >= 1 && tap.score <= 5).map((tap) => [tap.itemId, tap.score]));
      const words = Object.fromEntries(answer.cardWords.filter((said) => cards.some((card) => card.id === said.cardId) && said.words.trim()).map((said) => [said.cardId, said.words]));
      if (answer.insight && turn.insight?.text) {
        const ratings = readInsightRatings(store.getSetting(workspaceId, ONBOARDING_INSIGHTS));
        ratings[`eval#${last.seq}`] = { verdict: answer.insight, stage: turn.stage ?? "", at: new Date().toISOString(), text: turn.insight.text.slice(0, 300) };
        store.setSetting(workspaceId, ONBOARDING_INSIGHTS, JSON.stringify(ratings));
      }
      text = [composeAnswers(batch, answers, answer.freeText), ...cardLines(cards, taps, words)].filter((part) => part.trim()).join("\n") || "不确定。";
      earlier.push({ interviewer: turn.reply.slice(0, 600), me: text.slice(0, 600) });
      transcript.push("**回答**", "", text, ...(answer.insight ? ["", `（洞察：${answer.insight === "fits" ? "准" : "不准"}）`] : []), "");
    }
    // The interview said it is done (or ran out of rounds): the extraction's finishing runs write the synthesis, as the worker's tick asks
    // for them in the app; then the portrait writer, as the worker runs it once the interview is complete.
    const extractor = createOnboardingExtractor(store, workspaceId, repoRoot, () => client);
    await withUsageWorkspace(interviewKey, async () => {
      await extractionSettled(workspaceId);
      for (let run = 0; run < 3 && !json<{ portrait?: string }>("profile.model", {}).portrait; run += 1)
        await requestExtraction(workspaceId, (preferred) => extractor.runOnce(preferred), "eval");
    });
    const written = await withUsageWorkspace(interviewKey, () => createPortraitWriter(store, workspaceId, repoRoot, () => client)());
    log({ portrait: written.state, ...(written.state === "blocked" ? { code: written.code } : {}) });
    transcript.push(`画像：${written.state}${written.state === "blocked" ? ` ${written.code} ${written.message}` : ""}`);
  } catch (error) {
    transcript.push(`异常：${error instanceof Error ? error.message : String(error)}`);
    log({ error: error instanceof Error ? error.message.slice(0, 300) : "unknown" });
  } finally {
    const lines = identityLines(store, workspaceId).map((line) => ({ id: line.id, label: line.label, hard: Boolean(line.hard), rank: line.rank ?? null, goals: line.goals ?? [] }));
    const checklist = interviewChecklistFor(store, workspaceId, lines, { unfiledFiles: null });
    const answers = readInstrumentAnswers(store.getSetting(workspaceId, PROFILE_INSTRUMENTS_SETTING));
    const result = {
      name, opening, model, playerModel, state, turns, minutes: Math.round((Date.now() - started) / 60_000), readyAtRound: readyAt ?? null,
      complete: interviewComplete(checklist), goalsAdopted, rounds,
      lines, lineProfiles: json("lines.profiles", {}), profile: json("profile.model", {}), sections: readSectionRecords(store, workspaceId),
      portrait: json<{ report?: unknown }>("portrait.report", {}).report ?? null,
      claims: { cards: instrumentClaims(answers, new Date().toISOString()), written: json<{ claims?: unknown[] }>(PROFILE_CLAIMS_SETTING, {}).claims ?? [] },
      cardReadings: instrumentReadings(answers), cardAnswers: answers,
      insights: readInsightRatings(store.getSetting(workspaceId, ONBOARDING_INSIGHTS)),
      facts: store.listProfileFacts(workspaceId).map((fact) => ({ line: fact.identityId, project: fact.projectId, slot: fact.slot, value: fact.value, status: fact.status })),
      projects: store.listProjects(workspaceId).map((project) => ({ line: project.identityId, name: project.name })),
      checklist: checklist.map(({ id, label, done, owner, detail }) => ({ id, label, done, owner, detail })),
      cost: { interview: cost(interviewKey), player: cost(playerKey) }
    };
    writeFileSync(path.join(dir, "result.json"), JSON.stringify(result, null, 2), "utf8");
    writeFileSync(path.join(dir, "transcript.md"), transcript.join("\n"), "utf8");
    store.close();
    return { name, state, turns, readyAtRound: readyAt ?? null, complete: result.complete, portrait: Boolean(result.portrait), cost: result.cost };
  }
}

console.info(JSON.stringify({ step: "start", people: names, model, playerModel, out }));
// One person's failure must not take the others' results with it.
const summary = (await Promise.allSettled(names.map((name) => runPerson(name, openings[name]!))))
  .map((result, index) => result.status === "fulfilled" ? result.value : { person: names[index], state: "failed", error: String(result.reason) });
writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
console.info(JSON.stringify({ step: "done", summary }));
await supervisor.stop();
await gateway.close?.();
process.exit(0);
