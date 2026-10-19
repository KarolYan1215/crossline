import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { caseTools } from "./conformance-tools";
import path from "node:path";
import {
  admittedSkills, chooseSponsorModel, dominatedCandidates, skillKey, sponsorFallbacks, sponsorModelForSkill, ONBOARDING_TONE_SETTING, plainVoiceMarkers, plainVoiceRate, conformanceCases, evaluationYuanPerRun, conformanceCurrent, conformanceProblems, parseSponsorModels, thinkingVariant, sponsorMonth, sponsorSpend,
  SPONSOR_MONTHLY_CAP_CNY, summarizeConformance, type ConformanceRecord, type ConformanceRun, type CostSignal, type ProviderCapabilities,
  type SponsorEvaluation, type SponsorModel
} from "@crossline/core";
import { runCodexSkill, withUsageWorkspace, threadProvider, type CodexRpcBoundary, type GatewayUpstream, type ModelGateway, type ProviderConfig, type ProviderRouting, type SkillUsage } from "@crossline/codex";
import { CrosslineStore, sponsorshipOf, type StoredOnboardingMessage } from "@crossline/db";
import { LINE_SETTING, type LineSpec } from "@crossline/identity-packs";
import { createOnboardingExtractor } from "./onboarding-extract";
import { readSectionRecords } from "./onboarding-persist";
import { createOnboardingSessionRunner } from "./onboarding-session";
import { RUNTIME_VERSION } from "./model-provider";

/**
 * The developer's model for invited accounts (2026-10-18; rules in `packages/core/src/sponsor.ts`). The key is the server's own
 * (`CROSSLINE_SPONSOR_API_KEY`, never written to the ledger or shown), the candidates and their prices come from the environment, and
 * which candidate serves is decided by running the conformance cases on each through the same gateway a person's own provider uses.
 * The measurements live beside the ledger in `sponsor.json`, so a restart does not test again until a record goes stale.
 */
export const SPONSOR_PROVIDER_ID = "sponsor";
/** Usage of evaluation runs is attributed to this prefix, never to a workspace: the sink hands it here instead of the ledger. */
export const SPONSOR_EVAL_PREFIX = "sponsor-eval:";
const CONFORMANCE_SKILL = "crossline:crossline-conformance";
/**
 * Records made before this version lack the per-run log (`sponsor-eval/<model>.jsonl`) the comparison is read from, and are tested
 * again so every candidate is measured the same way. 4 (2026-10-19): the interview cites sentence numbers and writes times as minutes,
 * so every candidate is measured again on the schemas it will actually be asked for. 5 (2026-10-19): the interview is two Skills, the
 * dialogue and the extraction, each with its own schema, and both must pass. 6 (2026-10-19): every Skill's prompt was rewritten and the
 * extraction forgives an enum slip (`dropEnumSlips`); the owner asked for the candidates to be measured again once that was done. 7
 * (2026-10-19): the key's balance ran out during the version 6 measurement and every candidate was recorded as failing everything.
 */
export const SPONSOR_EVAL_VERSION = 7;
/**
 * The sample interview's own version: a change to the interview prompt or the script re-runs only the three sample turns of every
 * candidate (minutes and a few jiao each), not its thirty-odd conformance runs. 3 (2026-10-19): the extraction is run once on the sample's
 * replies too, so each candidate's speed and recall on the background layer can be compared (the owner asked whether a faster model would do).
 */
export const SPONSOR_DIALOGUE_VERSION = 3;
/** Usage and routing key of a candidate's sample interview (`sponsor-eval:dialogue:<model>`): counted with the evaluation, never a ledger. */
export const SPONSOR_DIALOGUE_PREFIX = `${SPONSOR_EVAL_PREFIX}dialogue:`;

/**
 * The sample interview every candidate is given (2026-10-18, the owner's request: judge how it writes and whether it sounds like a
 * person, not only whether its JSON holds). A fictional graduate student with three lines, answered the same way for every model: the
 * opening card, a reply full of facts and one uncertainty, and a worried one. Synthetic, so the replies can be logged whole.
 */
export const SPONSOR_DIALOGUE_SCRIPT = [
  "【语气】温柔体贴\n【我的主线】研究者、创业者、创作者\n【未来 12–24 个月的底座】研究者\n【有固定日程的主线】研究者\n没有材料，直接开始访谈。",
  "我是研二，做忆阻器阵列的仿真，导师要求 12 月中投一篇会议论文，现在实验数据还差一半。创业是和本科室友做一个给研究生排期的小工具，还没有用户。"
    + "自媒体在小红书写科研日常，800 个粉丝，想做到 1 万。周一三五上午组会和上课，平时每周大概能拿出 50 小时，晚上效率最高。创业到底该投多少时间我也说不清。",
  "说实话最近有点焦虑。三条线都想做好，结果每条都推进很慢，一天要切换好几次，晚上复盘觉得什么都没做完。有时候会想是不是该砍掉一条，但又舍不得。"
] as const;

/** One turn of the sample interview as logged: what the person said, what came back, and what it cost. */
export type SponsorDialogueLog = {
  at: string; model: string; turn: number; said: string; ok: boolean; code?: string; message?: string;
  /** What the runner said beyond the code (the item a model was refused, the provider's own error). */
  detail?: string;
  reply: string; questions: Array<{ text: string; kind: string; options: string[] }>; stage: string; nextAction: string;
  serviceMs: number | null; wallMs: number; repairs: number;
  /** Machine-made writing in the reply (`plainVoiceMarkers`) and all hits per thousand characters. */
  voice: ReturnType<typeof plainVoiceMarkers>; voiceRate: number;
  tokens: { input: number; cached: number; output: number; reasoning: number };
};

/**
 * One conformance run as written to the log: whether it passed first time, what the validator sent back and what the model answered
 * then (the cases are synthetic, so the answer carries no person's data), and the model's own time apart from the wait for a slot.
 */
export type SponsorRunLog = {
  at: string; model: string; caseId: string; attempt: number; ok: boolean; code?: string; repairs: number; stalls: number;
  rejections: Array<{ problems: string; answer: string }>;
  /** Repairs the validator did not ask for: the answer was not JSON (or the turn failed before it was read). */
  unparsed: number;
  serviceMs: number | null; wallMs: number; turnSeconds: number[];
  tokens: { input: number; cached: number; output: number; reasoning: number };
};

/**
 * What the sample's replies state, each as a pattern the recorded facts should contain: how much of it one extraction run wrote down.
 * Read off `SPONSOR_DIALOGUE_SCRIPT`; a change there changes these.
 */
export const SPONSOR_EXTRACT_EXPECTED: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "研二", pattern: /研二|二年级/ }, { label: "忆阻器仿真", pattern: /忆阻器/ }, { label: "12 月中投稿", pattern: /12\s*月/ },
  { label: "数据差一半", pattern: /一半/ }, { label: "排期工具", pattern: /排期/ }, { label: "还没有用户", pattern: /没有用户|无用户|0\s*个?用户|零用户/ },
  { label: "800 粉丝", pattern: /800/ }, { label: "目标 1 万", pattern: /1\s*万|10000|10,000/ }, { label: "周一三五上午", pattern: /周一|星期一|一、三、五|一三五/ },
  { label: "每周 50 小时", pattern: /50/ }, { label: "晚上效率高", pattern: /晚上|夜间|夜里/ }
];

/** Which of the expected statements a text holds. */
export const extractRecall = (text: string) => SPONSOR_EXTRACT_EXPECTED.filter((item) => item.pattern.test(text)).map((item) => item.label);

/** The extraction run on the sample interview's replies, as logged: time, tokens and what it wrote (all of it synthetic). */
export type SponsorExtractLog = {
  at: string; model: string; kind: "extract"; ok: boolean; code?: string; message?: string; replies: number;
  serviceMs: number | null; wallMs: number; repairs: number;
  tokens: { input: number; cached: number; output: number; reasoning: number };
  facts: string[]; projects: string[]; sections: string[]; recalled: string[]; recall: number;
};

/**
 * The thinking trial (2026-10-19, the owner: 「赞助模型规划太慢：先做测试」): on the planning Skills the developer's model spent most of its
 * time reasoning (the step planner's median run 510 s with 14k reasoning tokens). The chosen model and the fastest candidate run each
 * planning case with thinking as it is, capped at 2048 tokens and off, logged in `<model>.effort.jsonl` so a lower setting is chosen
 * from measurements, not guessed. It does not enter the automatic choice. 2 (2026-10-19): version 1 ran on a spent key and measured nothing.
 */
export const SPONSOR_EFFORT_VERSION = 2;
export const SPONSOR_EFFORT_CASES = ["STEP_PLAN_SCHEMA", "BACKPLAN_SCHEMA", "MILESTONE_PROPOSAL_SCHEMA", "ANALYSIS_OUTPUT_SCHEMA", "ONBOARDING_EXTRACT_SCHEMA", "ARTIFACT_PLAN_SCHEMA"];
export const SPONSOR_EFFORT_VARIANTS = ["", "@think:2048", "@think:off"] as const;
export type SponsorEffortLog = { at: string; model: string; variant: string; caseId: string; ok: boolean; code?: string; repairs: number;
  serviceMs: number | null; wallMs: number; tokens: { input: number; cached: number; output: number; reasoning: number } };

/**
 * The key's balance is spent (SiliconFlow answers every call at once with a quota error, nothing reaches a model): nothing measured
 * from then on says anything about a candidate, so the measurement stops and no record is written.
 */
export const SPONSOR_KEY_EXHAUSTED = "SPONSOR_KEY_EXHAUSTED";
const spent = (code: string | undefined) => code === "SKILL_USAGE_LIMIT";
const exhaustedError = (error: unknown) => error instanceof Error && error.message === SPONSOR_KEY_EXHAUSTED;

/** `lastChosen`: the model last chosen, served while a new evaluation runs (the owner's decision of 2026-10-19: no pause). */
type Saved = { evaluations: SponsorEvaluation[]; lastChosen?: SponsorEvaluation };

export function sponsorFromEnv(env: NodeJS.ProcessEnv = process.env): { key: string; baseUrl: string; models: SponsorModel[]; capYuan: number } | undefined {
  const key = env.CROSSLINE_SPONSOR_API_KEY?.trim();
  const models = parseSponsorModels(env.CROSSLINE_SPONSOR_MODELS);
  if (!key || !models.length) return undefined;
  const cap = Number(env.CROSSLINE_SPONSOR_MONTHLY_CNY);
  return { key, baseUrl: (env.CROSSLINE_SPONSOR_BASE_URL?.trim() || "https://api.siliconflow.cn/v1").replace(/\/+$/, ""), models,
    capYuan: cap > 0 ? cap : SPONSOR_MONTHLY_CAP_CNY };
}

export function createSponsorService(options: {
  store: CrosslineStore; dataDir: string; cwd: string; gateway: ModelGateway; capabilities: ProviderCapabilities;
  /** A runtime to run the evaluation threads on (the owner's sidecar): the provider is defined per thread, so any client serves. */
  client: () => CodexRpcBoundary | undefined;
  env?: NodeJS.ProcessEnv; now?: () => Date; fetch?: typeof fetch;
}) {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const file = path.join(options.dataDir, "sponsor.json");
  const evalUsage = new Map<string, { inputTokens: number; cachedInputTokens: number; outputTokens: number }>();
  // The usage of the run under way for each candidate (one at a time per candidate), for its log line.
  const runUsage = new Map<string, SkillUsage>();
  const logDir = path.join(options.dataDir, "sponsor-eval");
  const slug = (model: string) => model.replace(/[^A-Za-z0-9._-]+/g, "_");
  const logFile = (model: string) => path.join(logDir, `${slug(model)}.jsonl`);
  const dialogueFile = (model: string) => path.join(logDir, `${slug(model)}.dialogue.jsonl`);
  const extractFile = (model: string) => path.join(logDir, `${slug(model)}.extract.jsonl`);
  const effortFile = (model: string) => path.join(logDir, `${slug(model)}.effort.jsonl`);
  let evaluating = false;

  const settings = () => sponsorFromEnv(env);
  const read = (): Saved => {
    try { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Saved : { evaluations: [] }; } catch { return { evaluations: [] }; }
  };
  /** Candidates another beats on pass rate, cost and slowest run, with the one that beats them: never measured again, never used. */
  const offFrontier = (): Map<string, string> => {
    const config = settings();
    return config ? dominatedCandidates(read().evaluations, config.models) : new Map();
  };
  const currentEvaluations = (): SponsorEvaluation[] => {
    const config = settings();
    if (!config) return [];
    const dominated = offFrontier();
    // A record without token totals predates pricing by tokens and could only be compared at the prices it ran under: tested again.
    return read().evaluations.filter((item) => item.tokens && item.version === SPONSOR_EVAL_VERSION && config.models.some((model) => model.model === item.model)
      && !dominated.has(item.model) && conformanceCurrent(item.record, item.model, RUNTIME_VERSION, now()));
  };
  /** Writes the evaluations, keeping the last choice. */
  const save = (evaluations: SponsorEvaluation[], lastChosen = read().lastChosen) =>
    writeFileSync(file, JSON.stringify({ evaluations, ...(lastChosen ? { lastChosen } : {}) } satisfies Saved, null, 2), "utf8");
  /** The current choice; while a new evaluation has chosen nothing yet, the last one (if that model is still listed). */
  const chosen = (): SponsorEvaluation | undefined => {
    const config = settings();
    if (!config) return undefined;
    const current = chooseSponsorModel(config.models, currentEvaluations(), options.capabilities);
    if (current) return current;
    const saved = read();
    const last = saved.lastChosen;
    if (last && config.models.some((model) => model.model === last.model)) return last;
    // No choice kept yet: the best of the older records that reached a model, so invited accounts are not paused for a re-measurement.
    const dominated = offFrontier();
    return chooseSponsorModel(config.models, saved.evaluations.filter((item) => (item.tokens?.input ?? 0) > 0 && !dominated.has(item.model)), options.capabilities);
  };
  /** What per-Skill choices are made from: the current records, or only the last choice while none is current. */
  const pool = (): SponsorEvaluation[] => {
    const current = currentEvaluations();
    if (current.length && settings() && chooseSponsorModel(settings()!.models, current, options.capabilities)) return current;
    const last = chosen();
    return last ? [last] : [];
  };
  /** The model a Skill runs on (a simple background Skill may run on a cheaper candidate that passed it). */
  const modelFor = (skill: string): string | undefined => {
    const config = settings();
    const pick = chosen();
    return config && pick ? sponsorModelForSkill(skill, pick.model, config.models, pool(), options.capabilities) : undefined;
  };
  const providerFor = (model: string): ProviderConfig => {
    const contextK = settings()?.models.find((item) => item.model === thinkingVariant(model).base)?.contextK;
    return { id: SPONSOR_PROVIDER_ID, kind: "chat", label: "开发者提供的模型", baseUrl: settings()?.baseUrl ?? "",
      model, responseFormat: "json_object", keyLast4: null, updatedAt: "1970-01-01T00:00:00.000Z", ...(contextK ? { contextK } : {}) };
  };

  /** Yuan the account has spent on the sponsor's models this calendar month, and the cap. */
  const budget = (workspaceId: string): { spent: number; cap: number; resetsAt: Date } | undefined => {
    const config = settings();
    if (!config) return undefined;
    const month = sponsorMonth(now());
    const usage = options.store.summarizeModelUsage(workspaceId, month.start)
      .map((row) => ({ model: row.model, inputTokens: row.inputTokens, cachedInputTokens: row.cachedInputTokens, outputTokens: row.outputTokens }));
    return { spent: Math.round(sponsorSpend(usage, config.models) * 100) / 100, cap: config.capYuan, resetsAt: month.next };
  };

  /** Whether this account runs on the sponsor: it redeemed a code and the server has a key and a chosen model. */
  const active = (workspaceId: string): boolean => Boolean(settings() && sponsorshipOf(options.store, workspaceId));

  /** The account's quota while it runs on the sponsor: its share of the monthly cap, as one window that resets on the 1st. */
  const cost = (workspaceId: string): CostSignal | undefined => {
    if (!active(workspaceId)) return undefined;
    const spend = budget(workspaceId)!;
    const usedPercent = Math.min(100, Math.round((spend.spent / spend.cap) * 100));
    return { available: true, limitReached: spend.spent >= spend.cap, money: { spent: spend.spent, cap: spend.cap },
      long: { usedPercent, windowDurationMins: null, resetsAt: Math.floor(spend.resetsAt.getTime() / 1000) } };
  };

  /**
   * What the gateway forwards to: the sponsor's base URL with the server key; the model is the one the thread names. A person's turn
   * refused for load may go to another candidate that passed the Skill; an evaluation's run never does, or it would measure the wrong model.
   */
  const upstream = (workspaceId = ""): GatewayUpstream | undefined => {
    const config = settings();
    if (!config) return undefined;
    const measuring = workspaceId.startsWith(SPONSOR_EVAL_PREFIX);
    return { kind: "chat", baseUrl: config.baseUrl, responseFormat: "json_object", key: config.key, thinkingControl: true,
      ...(measuring ? {} : { fallback: (skill: string, model: string) => sponsorFallbacks(skillKey(skill), model, config.models, pool(), options.capabilities) }) };
  };

  /** Models the key can use, or undefined when the list cannot be read (then every candidate is tried). */
  async function listed(): Promise<Set<string> | undefined> {
    const config = settings();
    if (!config) return undefined;
    try {
      const answer = await (options.fetch ?? fetch)(`${config.baseUrl}/models`, { headers: { authorization: `Bearer ${config.key}` }, signal: AbortSignal.timeout(20_000) });
      if (!answer.ok) {
        console.info(JSON.stringify({ type: "sponsor.catalog_unread", status: answer.status }));
        return undefined;
      }
      const body = await answer.json() as { data?: Array<{ id?: string }> };
      const ids = (body.data ?? []).map((item) => item.id ?? "").filter(Boolean);
      // Every model the key can use, so a candidate named wrongly in the list can be corrected from the log.
      console.info(JSON.stringify({ type: "sponsor.catalog", models: ids.slice(0, 120) }));
      return new Set(ids);
    } catch (error) {
      console.info(JSON.stringify({ type: "sponsor.catalog_unread", error: error instanceof Error ? error.message.slice(0, 120) : "unknown" }));
      return undefined;
    }
  }

  /**
   * Tests every candidate without a current record, side by side; the choice follows from the records. Safe to call often.
   * `exhausted`: the key's balance ran out, so what was not measured is measured again on a later call, once there is money.
   */
  async function evaluate(): Promise<{ chosen?: string; tested: string[]; skipped: string[]; exhausted: boolean }> {
    const config = settings();
    const client = options.client();
    if (!config || !client || evaluating) return { tested: [], skipped: [], exhausted: false };
    evaluating = true;
    const tested: string[] = [];
    const skipped: string[] = [];
    let exhausted = false;
    // A spent key stops the measurement where it is; whatever was not measured stays unrecorded.
    const unlessSpent = (model: string, error: unknown): false => {
      if (exhaustedError(error)) exhausted = true;
      else console.info(JSON.stringify({ type: "sponsor.measure_failed", model, message: error instanceof Error ? error.message.slice(0, 160) : "unknown" }));
      return false;
    };
    try {
      const available = await listed();
      const have = new Set(currentEvaluations().map((item) => item.model));
      const dominated = offFrontier();
      const pending = config.models.filter((model) => {
        if (have.has(model.model) || dominated.has(model.model)) return false;
        if (available && !available.has(model.model)) { skipped.push(model.model); return false; }
        return true;
      });
      // The candidates are tested side by side (each run takes minutes, one model's thirty-odd runs one after another take an hour or
      // two); each result is written as soon as it is in, so a restart keeps the models already measured.
      // A candidate measured before the sample interview last changed gets only the new sample interview.
      const redialogue = currentEvaluations().filter((item) => item.dialogueVersion !== SPONSOR_DIALOGUE_VERSION)
        .map((item) => config.models.find((model) => model.model === item.model)).filter((model): model is SponsorModel => Boolean(model));
      await Promise.all(redialogue.map(async (model) => {
        if (!await sampleDialogue(client, model).then(() => true, (error: unknown) => unlessSpent(model.model, error))) return;
        const saved = read().evaluations.map((item) => item.model === model.model ? { ...item, dialogueVersion: SPONSOR_DIALOGUE_VERSION } : item);
        save(saved);
      }));
      await Promise.all(pending.map(async (model) => {
        const evaluation = await evaluateOne(client, model).catch((error: unknown) => unlessSpent(model.model, error));
        // A candidate whose runs never reached the model was not measured: a record of zeros would keep it out for thirty days.
        if (!evaluation || !evaluation.tokens?.input) return;
        const saved = read().evaluations.filter((item) => item.model !== model.model);
        save([...saved, evaluation]);
        tested.push(model.model);
        console.info(JSON.stringify({ type: "sponsor.evaluated", model: model.model, passRate: evaluation.record.passRate,
          repairRate: evaluation.record.repairRate, p95Ms: evaluation.record.p95Ms, yuanPerRun: evaluation.yuanPerRun, tokens: evaluation.tokens,
          admitted: admittedSkills(evaluation.record, options.capabilities).length, failures: evaluation.record.failures.slice(0, 6) }));
      }));
    } finally { evaluating = false; }
    // A choice from current records is kept as the last choice, served while a later evaluation runs.
    const listedModels = settings()?.models;
    const current = listedModels ? chooseSponsorModel(listedModels, currentEvaluations(), options.capabilities) : undefined;
    if (current) save(read().evaluations, current);
    const pick = chosen();
    // The thinking trial on the chosen model and the fastest other candidate on the frontier, once per trial version.
    const fastest = currentEvaluations().filter((item) => item.model !== pick?.model).sort((a, b) => a.record.p95Ms - b.record.p95Ms)[0]?.model;
    const trial = [...new Set([pick?.model, fastest].filter((model): model is string => Boolean(model)))]
      .filter((model) => currentEvaluations().some((item) => item.model === model && item.effortVersion !== SPONSOR_EFFORT_VERSION));
    if (trial.length && !exhausted) {
      evaluating = true;
      try {
        await Promise.all(trial.map(async (model) => {
          if (!await effortTrial(client, model).then(() => true, (error: unknown) => unlessSpent(model, error))) return;
          const saved = read().evaluations.map((item) => item.model === model ? { ...item, effortVersion: SPONSOR_EFFORT_VERSION } : item);
          save(saved);
        }));
      } finally { evaluating = false; }
    }
    // Every measured candidate at the current prices, so a price change shows its effect on the next start.
    const candidates = currentEvaluations().map((item) => ({ model: item.model, passRate: item.record.passRate, p95Ms: item.record.p95Ms,
      yuanPerRun: evaluationYuanPerRun(item, config.models), tokens: item.tokens ?? null }));
    const pruned = [...offFrontier()].map(([model, by]) => ({ model, by }));
    if (pruned.length) console.info(JSON.stringify({ type: "sponsor.pruned", pruned }));
    if (exhausted) console.info(JSON.stringify({ type: "sponsor.key_exhausted", balance: await balance() ?? null }));
    console.info(JSON.stringify({ type: "sponsor.chosen", model: pick?.model ?? null, skipped, candidates }));
    return { ...(pick ? { chosen: pick.model } : {}), tested, skipped, exhausted };
  }

  /** What is left on the key (SiliconFlow's `/user/info`; only the amounts and status are kept), or undefined when it cannot be read. */
  async function balance(): Promise<{ balance: string; chargeBalance: string; totalBalance: string; status: string } | undefined> {
    const config = settings();
    if (!config) return undefined;
    try {
      const answer = await (options.fetch ?? fetch)(`${config.baseUrl}/user/info`, { headers: { authorization: `Bearer ${config.key}` }, signal: AbortSignal.timeout(20_000) });
      if (!answer.ok) return undefined;
      const data = (await answer.json() as { data?: Record<string, unknown> }).data ?? {};
      const text = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value) : "";
      return { balance: text(data.balance), chargeBalance: text(data.chargeBalance), totalBalance: text(data.totalBalance), status: text(data.status) };
    } catch { return undefined; }
  }

  async function evaluateOne(client: CodexRpcBoundary, model: SponsorModel): Promise<SponsorEvaluation> {
    const provider = providerFor(model.model);
    const thread = threadProvider({ provider, gatewayUrl: options.gateway.urlFor(`${SPONSOR_EVAL_PREFIX}${model.model}`, SPONSOR_PROVIDER_ID) }, model.model);
    const runs: ConformanceRun[] = [];
    const key = `${SPONSOR_EVAL_PREFIX}${model.model}`;
    evalUsage.set(key, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
    // A fresh log per evaluation: what is read afterwards is this measurement, whole.
    mkdirSync(logDir, { recursive: true });
    writeFileSync(logFile(model.model), "", "utf8");
    // How it talks first: the sample interview takes minutes, and its replies are what the owner reads.
    try {
      await sampleDialogue(client, model).catch((error: unknown) => {
        if (exhaustedError(error)) throw error;
        console.info(JSON.stringify({ type: "sponsor.dialogue_failed", model: model.model, message: error instanceof Error ? error.message.slice(0, 160) : "unknown" }));
      });
      return await conformanceRuns(client, model, thread, key, runs);
    } finally {
      evalUsage.delete(key);
      runUsage.delete(key);
    }
  }

  async function conformanceRuns(client: CodexRpcBoundary, model: SponsorModel, thread: ReturnType<typeof threadProvider>, key: string,
    runs: ConformanceRun[]): Promise<SponsorEvaluation> {
    for (const item of conformanceCases()) for (let attempt = 0; attempt < item.runs; attempt += 1) {
      const started = Date.now();
      const input = { version: "crossline.conformance.v1", caseId: item.id, prompt: item.prompt };
      const rejections: SponsorRunLog["rejections"] = [];
      let audit: { repairs?: number; stalls?: number } = {};
      runUsage.delete(key);
      const offered = caseTools(item);
      const result = await withUsageWorkspace(key, () => runCodexSkill<unknown>(client, input, { skillName: CONFORMANCE_SKILL, cwd: options.cwd, provider: thread,
        ...(offered.tools ? { tools: offered.tools } : {}),
        developerInstructions: "Answer the conformance case as the Skill describes. Return raw JSON only.", outputSchema: item.schema,
        prepareInput: () => input, onAudit: (next) => { audit = next; }, timeoutMs: 20 * 60_000,
        validateOutput: (output) => {
          const problems = conformanceProblems(item.id, output, item.schema);
          if (problems.length) {
            rejections.push({ problems: problems.slice(0, 6).join("; ").slice(0, 500), answer: JSON.stringify(output).slice(0, 600) });
            throw Object.assign(new Error("CONFORMANCE_SCHEMA_VIOLATED"), { detail: problems.slice(0, 6).join("; ") });
          }
          try { offered.check(output); } catch (error) {
            rejections.push({ problems: (error as Error).message, answer: JSON.stringify(output).slice(0, 600) });
            throw error;
          }
          return output;
        } })).catch((error: unknown) => ({ ok: false as const, blocker: { code: error instanceof Error ? error.message : "SKILL_RUNTIME_FAILED", message: "" }, audit: {} as { repairs?: number; stalls?: number } }));
      const repairs = result.audit.repairs ?? audit.repairs ?? 0;
      const usage = runUsage.get(key);
      const wallMs = Date.now() - started;
      // The model's own time when the run reported it, so the queue for a slot (shared by every candidate) does not count against one.
      const serviceMs = usage ? usage.durationMs : null;
      runs.push({ caseId: item.id, ok: result.ok, repairs, ms: serviceMs ?? wallMs, ...(result.ok ? {} : { code: result.blocker.code }) });
      const line: SponsorRunLog = { at: new Date(started).toISOString(), model: model.model, caseId: item.id, attempt, ok: result.ok,
        ...(result.ok ? {} : { code: result.blocker.code }), repairs, stalls: result.audit.stalls ?? audit.stalls ?? 0, rejections,
        unparsed: Math.max(0, repairs - rejections.length + (result.ok ? 0 : 1)), serviceMs, wallMs, turnSeconds: usage?.turnSeconds ?? [],
        tokens: { input: usage?.inputTokens ?? 0, cached: usage?.cachedInputTokens ?? 0, output: usage?.outputTokens ?? 0, reasoning: usage?.reasoningOutputTokens ?? 0 } };
      try { appendFileSync(logFile(model.model), `${JSON.stringify(line)}\n`, "utf8"); } catch { /* the log is for reading, never a reason to fail the measurement */ }
      if (!result.ok && spent(result.blocker.code)) throw new Error(SPONSOR_KEY_EXHAUSTED);
    }
    const record: ConformanceRecord = summarizeConformance({ providerId: SPONSOR_PROVIDER_ID, model: model.model, runtimeVersion: RUNTIME_VERSION, ranAt: now().toISOString() }, runs);
    const tokens = evalUsage.get(key)!;
    const evaluation: SponsorEvaluation = { model: model.model, record, yuanPerRun: 0, version: SPONSOR_EVAL_VERSION, dialogueVersion: SPONSOR_DIALOGUE_VERSION,
      tokens: { input: tokens.inputTokens, cached: tokens.cachedInputTokens, output: tokens.outputTokens, runs: runs.length } };
    return { ...evaluation, yuanPerRun: evaluationYuanPerRun(evaluation, [model]) };
  }

  /** Each planning case once per thinking setting, on one candidate; the log line per run is the measurement. */
  async function effortTrial(client: CodexRpcBoundary, model: string): Promise<void> {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(effortFile(model), "", "utf8");
    const cases = conformanceCases().filter((item) => SPONSOR_EFFORT_CASES.includes(item.id));
    const summary: Record<string, { ok: number; runs: number; serviceMs: number; reasoning: number }> = {};
    for (const variant of SPONSOR_EFFORT_VARIANTS) {
      const named = `${model}${variant}`;
      const thread = threadProvider({ provider: providerFor(named), gatewayUrl: options.gateway.urlFor(`${SPONSOR_EVAL_PREFIX}${model}`, SPONSOR_PROVIDER_ID) }, named);
      const key = `${SPONSOR_EVAL_PREFIX}effort:${named}`;
      for (const item of cases) {
        const started = Date.now();
        const input = { version: "crossline.conformance.v1", caseId: item.id, prompt: item.prompt };
        runUsage.delete(key);
        const offered = caseTools(item);
        const result = await withUsageWorkspace(key, () => runCodexSkill<unknown>(client, input, { skillName: CONFORMANCE_SKILL, cwd: options.cwd, provider: thread,
          ...(offered.tools ? { tools: offered.tools } : {}),
          developerInstructions: "Answer the conformance case as the Skill describes. Return raw JSON only.", outputSchema: item.schema,
          prepareInput: () => input, onAudit: () => {}, timeoutMs: 20 * 60_000,
          validateOutput: (output) => {
            const problems = conformanceProblems(item.id, output, item.schema);
            if (problems.length) throw Object.assign(new Error("CONFORMANCE_SCHEMA_VIOLATED"), { detail: problems.slice(0, 6).join("; ") });
            return output;
          } })).catch((error: unknown) => ({ ok: false as const, blocker: { code: error instanceof Error ? error.message : "SKILL_RUNTIME_FAILED", message: "" }, audit: {} as { repairs?: number } }));
        const usage = runUsage.get(key);
        const line: SponsorEffortLog = { at: new Date(started).toISOString(), model, variant: variant || "default", caseId: item.id, ok: result.ok,
          ...(result.ok ? {} : { code: result.blocker.code }), repairs: result.audit.repairs ?? 0, serviceMs: usage ? usage.durationMs : null, wallMs: Date.now() - started,
          tokens: { input: usage?.inputTokens ?? 0, cached: usage?.cachedInputTokens ?? 0, output: usage?.outputTokens ?? 0, reasoning: usage?.reasoningOutputTokens ?? 0 } };
        try { appendFileSync(effortFile(model), `${JSON.stringify(line)}\n`, "utf8"); } catch { /* the log is for reading only */ }
        if (!result.ok && spent(result.blocker.code)) throw new Error(SPONSOR_KEY_EXHAUSTED);
        const tally = summary[line.variant] ??= { ok: 0, runs: 0, serviceMs: 0, reasoning: 0 };
        tally.runs += 1; tally.ok += line.ok ? 1 : 0; tally.serviceMs += line.serviceMs ?? line.wallMs; tally.reasoning += line.tokens.reasoning;
      }
    }
    console.info(JSON.stringify({ type: "sponsor.effort_sampled", model, variants: summary }));
  }

  /**
   * The sample interview on a throwaway ledger: the real interview runner, the real Skill and its checks, routed to this candidate
   * through the same gateway (`dialogueRouting`). Each turn's reply and questions are logged whole for reading; nothing reaches a ledger.
   */
  async function sampleDialogue(client: CodexRpcBoundary, model: SponsorModel): Promise<void> {
    writeFileSync(dialogueFile(model.model), "", "utf8");
    const scratch = new CrosslineStore(":memory:");
    try {
      const workspaceId = scratch.createPrincipalWithWorkspace(`sponsor-eval-${slug(model.model)}`, "检验").workspace.id;
      scratch.setSetting(workspaceId, ONBOARDING_TONE_SETTING, "warm");
      // The lines the fictional person chose, saved as the opening card saves them (without, every candidate asked about a fourth line).
      const at = new Date(0).toISOString();
      scratch.setSetting(workspaceId, LINE_SETTING, JSON.stringify([
        { id: "research", label: "研究者", color: "research", goal: "", createdAt: at, hard: true, rank: 1 },
        { id: "startup", label: "创业者", color: "startup", goal: "", createdAt: at },
        { id: "media", label: "创作者", color: "media", goal: "", createdAt: at }] satisfies LineSpec[]));
      // The dialogue alone: its usage is what each line logs, and the extraction's schema is measured by the conformance cases.
      const run = createOnboardingSessionRunner(scratch, workspaceId, options.cwd, () => client, { extract: "off" });
      const key = `${SPONSOR_DIALOGUE_PREFIX}${model.model}`;
      for (const [index, said] of SPONSOR_DIALOGUE_SCRIPT.entries()) {
        const started = Date.now();
        runUsage.delete(key);
        const outcome = await withUsageWorkspace(key, () => run({ sessionId: "sample", text: said }));
        const usage = runUsage.get(key);
        const last: StoredOnboardingMessage | undefined = scratch.listOnboardingMessages(workspaceId, "sample").at(-1);
        const answer = outcome.state !== "blocked" && last?.role === "assistant" ? last.content as {
          reply?: string; questions?: Array<{ text?: string; kind?: string; options?: Array<{ label?: string }> }>; stage?: string; nextAction?: string } : undefined;
        const line: SponsorDialogueLog = { at: new Date(started).toISOString(), model: model.model, turn: index + 1, said, ok: Boolean(answer),
          ...(outcome.state === "blocked" ? { code: outcome.code, message: outcome.message.slice(0, 300), ...(outcome.detail ? { detail: outcome.detail.slice(0, 300) } : {}) } : {}),
          reply: answer?.reply ?? "", questions: (answer?.questions ?? []).map((question) => ({ text: question.text ?? "", kind: question.kind ?? "",
            options: (question.options ?? []).map((option) => option.label ?? "") })), stage: answer?.stage ?? "", nextAction: answer?.nextAction ?? "",
          serviceMs: usage ? usage.durationMs : null, wallMs: Date.now() - started, repairs: usage?.repairs ?? 0,
          voice: plainVoiceMarkers(answer?.reply ?? ""), voiceRate: plainVoiceRate(answer?.reply ?? ""),
          tokens: { input: usage?.inputTokens ?? 0, cached: usage?.cachedInputTokens ?? 0, output: usage?.outputTokens ?? 0, reasoning: usage?.reasoningOutputTokens ?? 0 } };
        try { appendFileSync(dialogueFile(model.model), `${JSON.stringify(line)}\n`, "utf8"); } catch { /* the log is for reading only */ }
        if (outcome.state === "blocked" && spent(outcome.code)) throw new Error(SPONSOR_KEY_EXHAUSTED);
        // A turn that failed leaves nothing to answer: the rest of the script would only measure the same failure again.
        if (!line.ok) break;
      }
      await sampleExtraction(client, model, scratch, workspaceId, key).catch((error: unknown) => console.info(JSON.stringify({ type: "sponsor.extract_failed",
        model: model.model, message: error instanceof Error ? error.message.slice(0, 160) : "unknown" })));
    } finally { scratch.close(); }
  }

  /**
   * One extraction run over the sample's replies, routed to the same candidate: how long the background layer takes on it and how much
   * of what the person said it wrote down (`extractRecall`). Logged whole; it does not enter the automatic choice.
   */
  async function sampleExtraction(client: CodexRpcBoundary, model: SponsorModel, scratch: CrosslineStore, workspaceId: string, key: string): Promise<void> {
    writeFileSync(extractFile(model.model), "", "utf8");
    const replies = scratch.listOnboardingMessages(workspaceId, "sample").filter((message) => message.role === "user").length;
    if (!replies) return;
    const started = Date.now();
    runUsage.delete(key);
    const extractor = createOnboardingExtractor(scratch, workspaceId, options.cwd, () => client);
    const outcome = await withUsageWorkspace(key, () => extractor.runOnce(["sample"]));
    const usage = runUsage.get(key);
    const facts = scratch.listProfileFacts(workspaceId).map((fact) => `${fact.identityId ?? ""}/${fact.projectId ?? ""}/${fact.slot}=${fact.value} (${fact.status})`);
    const projects = scratch.listProjects(workspaceId).filter((project) => !/-default$/.test(project.id)).map((project) => `${project.identityId}/${project.name}`);
    const sections = Object.entries(readSectionRecords(scratch, workspaceId)).filter(([, record]) => record).map(([section]) => section);
    const corpus = [...facts, ...projects, scratch.getSetting(workspaceId, "lines.profiles") ?? "", JSON.stringify(readSectionRecords(scratch, workspaceId))].join("\n");
    const recalled = extractRecall(corpus);
    const line: SponsorExtractLog = { at: new Date(started).toISOString(), model: model.model, kind: "extract", ok: outcome.state === "done",
      ...(outcome.state === "blocked" ? { code: outcome.code, message: outcome.message.slice(0, 300) } : {}), replies,
      serviceMs: usage ? usage.durationMs : null, wallMs: Date.now() - started, repairs: usage?.repairs ?? 0,
      tokens: { input: usage?.inputTokens ?? 0, cached: usage?.cachedInputTokens ?? 0, output: usage?.outputTokens ?? 0, reasoning: usage?.reasoningOutputTokens ?? 0 },
      facts, projects, sections, recalled, recall: Math.round(recalled.length / SPONSOR_EXTRACT_EXPECTED.length * 100) / 100 };
    try { appendFileSync(extractFile(model.model), `${JSON.stringify(line)}\n`, "utf8"); } catch { /* the log is for reading only */ }
    console.info(JSON.stringify({ type: "sponsor.extract_sampled", model: model.model, ok: line.ok, code: line.code, serviceMs: line.serviceMs,
      wallMs: line.wallMs, recall: line.recall, facts: facts.length, output: line.tokens.output, reasoning: line.tokens.reasoning }));
  }

  /**
   * Routing for an evaluation run that goes through the ordinary runner (the sample interview): this candidate, through the gateway,
   * with the interview admitted for the length of the test. Undefined for every other workspace.
   */
  function dialogueRouting(workspaceId: string | undefined): ProviderRouting | undefined {
    if (!workspaceId?.startsWith(SPONSOR_DIALOGUE_PREFIX) || !settings()) return undefined;
    const model = workspaceId.slice(SPONSOR_DIALOGUE_PREFIX.length);
    return { provider: providerFor(model), gatewayUrl: options.gateway.urlFor(workspaceId, SPONSOR_PROVIDER_ID),
      admitted: new Set(["crossline-onboarding", "crossline-onboarding-extract"]), codexSignedIn: false, capabilities: options.capabilities };
  }

  /** The usage sink's share: evaluation runs are counted here, never written to a workspace's ledger. */
  function noteEvalUsage(usage: SkillUsage): boolean {
    if (!usage.workspaceId?.startsWith(SPONSOR_EVAL_PREFIX)) return false;
    const tally = evalUsage.get(usage.workspaceId);
    runUsage.set(usage.workspaceId, usage);
    if (tally) {
      tally.inputTokens += usage.inputTokens;
      tally.cachedInputTokens += usage.cachedInputTokens;
      // Output already includes reasoning (see `UsageForPrice`).
      tally.outputTokens += usage.outputTokens;
    }
    return true;
  }

  /** What 设置 and the interview read: the chosen model and its record, and the account's month. */
  function view(workspaceId: string) {
    const pick = chosen();
    return { configured: Boolean(settings()), active: active(workspaceId), model: pick?.model ?? null, evaluating,
      budget: active(workspaceId) ? budget(workspaceId) : undefined, admitted: pick ? admittedSkills(pick.record, options.capabilities) : [] };
  }

  return { settings, chosen, modelFor, providerFor, budget, active, cost, upstream, evaluate, balance, noteEvalUsage, view, dialogueRouting, isEvaluating: () => evaluating };
}
export type SponsorService = ReturnType<typeof createSponsorService>;
