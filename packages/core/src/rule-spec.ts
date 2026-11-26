/**
 * The rule register (docs/plans/harness-1125.md §10, 2026-11-25): every regex, word list or validator in the code that passes a judgement
 * on natural language, with what it is for and when it goes. The point is to decide with data which rules to delete: a rule fires
 * (`ruleFired`, a JSONL line beside the data, never the ledger), `scripts/ablate.ts` replays fixtures and the person's corrections with
 * the rule on (`enforce`) and off (`record`), and a rule that changes nothing or disagrees with the person is retired.
 *
 * - `kind`: `invariant` guards a boundary (privacy, security) and is never ablated; `money` is the bookkeeping, kept enforced by the
 *   owner's decision of 2026-11-25 and never ablated; `evidence` checks a claim against the source text; `semantic` reads meaning a model
 *   could read; `style` shapes wording or keys.
 * - `mode`: `enforce` decides; `record` computes and logs but its verdict is not used (the run takes the model's answer, or the neutral
 *   default); `fallback` decides only when the model's field is missing (old data), and logs each time it does.
 * - `readers`: who acts on the rule's verdict. `retire`: the condition under which the rule is deleted.
 *
 * Every rule's code carries a `// rule: <id>` comment beside its pattern (`rule-spec.test.ts` checks both directions). A new Chinese
 * alternation regex in `packages/core/src` must be registered here or say `// not-nl: <why>` (it does not judge natural language).
 *
 * The mode can be overridden at run time for an ablation: `CROSSLINE_RULE_MODE="completion.legacy-title=record,…"` or `setRuleModes`.
 * `invariant` and `money` rules ignore overrides.
 */
export type RuleKind = "invariant" | "evidence" | "semantic" | "style" | "money";
export type RuleMode = "enforce" | "record" | "fallback";
export type RuleSpec = { file: string; kind: RuleKind; mode: RuleMode; what: string; readers: string; retire: string };

const CORE = "packages/core/src";

// i18n-ignore-start: developer documentation of each rule, never shown
export const RULE_SPEC = {
  // ── line-attributes.ts ───────────────────────────────────────────────────────────────────────────────────────────────
  "attribute.guess-kind": { file: `${CORE}/line-attributes.ts`, kind: "style", mode: "fallback",
    what: "guessKind: 领域/能力/状态 of an attribute from its words (「能…」「…能力」, 稳定/体面, trait words).",
    readers: "composeGoal (which parts share one 「的」), the attribute picker's order; lineAttributes and validateGoalSplit when the model gave no kind.",
    retire: "Every stored attribute carries the model's `kind` and the picker sends a kind with a typed attribute (one model call), so no call site reaches guessKind for a model's attribute; then composeGoal reads the stored kinds." },
  "attribute.not-atomic": { file: `${CORE}/line-attributes.ts`, kind: "style", mode: "enforce",
    what: "notAtomic: an attribute with an enumeration comma or 以及/并且 is two.",
    readers: "validateGoalSplit (sends the split back), the interview's attribute checks.",
    retire: "Ablation on recorded goal splits shows the model never returns a compound attribute the person later splits." },
  "attribute.goal-grammar": { file: `${CORE}/line-attributes.ts`, kind: "style", mode: "enforce",
    what: "The goal sentence's own grammar: 「成为」/become prefix, 方向/领域 suffix, 有/具备 before 「…能力」.",
    readers: "composeGoal, goalCore, attributeShapeProblem.",
    retire: "Not a judgement to hand over: it composes a template. Retire only with the template." },
  // ── feasibility.ts ───────────────────────────────────────────────────────────────────────────────────────────────────
  "opportunity.far-words": { file: `${CORE}/feasibility.ts`, kind: "semantic", mode: "fallback",
    what: "opportunityCategory: conference/competition/internship words in a title when the reader gave no `category`.",
    readers: "The travel check (local radius vs. trip) and the offer card's category.",
    retire: "No stored opportunity lacks `category` and the rule has not fired (`rule-fired.jsonl`) for 30 days." },
  "opportunity.quote-time": { file: `${CORE}/feasibility.ts`, kind: "evidence", mode: "enforce",
    what: "Clock words in an opportunity's quote: 北京时间, noon/中午, midnight/午夜, a 「至/到/-」 range, Chinese text for the zone.",
    readers: "When an opportunity starts and ends (feasibility, the calendar hold).",
    retire: "The reader returns start/end with the quote and the check only verifies them against the quote (then this becomes quote verification)." },
  // ── opportunity-discovery.ts (owner, 2026-11-25: eligibility is the model's, 「宁可多推」) ──
  "opportunity.stage-conflict": { file: `${CORE}/opportunity-discovery.ts`, kind: "semantic", mode: "record",
    what: "stageConflict: a full-time job while every watch of the line looks for internships, which the reader did not call wrong_stage.",
    readers: "Nobody acts on it: the reader's stageFit stands; the line is for the consistency review.",
    retire: "30 days of rule-fired lines show the reader's call agrees with what the person kept or dismissed; then delete stageConflict and INTERN." },
  // ── completion.ts ────────────────────────────────────────────────────────────────────────────────────────────────────
  "completion.legacy-title": { file: `${CORE}/completion.ts`, kind: "semantic", mode: "fallback",
    what: "completionRule's title words (考试/提交/探索/撰写…) for a task with no `payload.completion` from the model.",
    readers: "Whether 完成 is taken when pressed or asked about afterwards (the card, the completion ask).",
    retire: "No open or approved task lacks `payload.completion` (tasks written before the models judged completion); then delete the five regexes and default to the neutral rule." },
  // ── auto-approval.ts: taint routing (owner, 2026-11-25; docs/plans/harness-1125.md 「工具模式 Rule of Two」) ──
  "taint.money-signal": { file: `${CORE}/auto-approval.ts`, kind: "invariant", mode: "enforce",
    what: "taintedRisk: amounts, currencies and payment words in a task written by a run that read untrusted content.",
    readers: "autoApprovalEligible: such a task goes to 待确认 as a proposal instead of the calendar.",
    retire: "Not retired: a security boundary (a model that read the mail may be injected, so it cannot clear its own task)." },
  "taint.link-signal": { file: `${CORE}/auto-approval.ts`, kind: "invariant", mode: "enforce",
    what: "taintedRisk: a URL or bare domain in a task written by a tainted run.",
    readers: "autoApprovalEligible (same as taint.money-signal).",
    retire: "Not retired: a security boundary." },
  "taint.login-signal": { file: `${CORE}/auto-approval.ts`, kind: "invariant", mode: "enforce",
    what: "taintedRisk: login, password, code, account or ID-document words in a task written by a tainted run.",
    readers: "autoApprovalEligible (same as taint.money-signal).",
    retire: "Not retired: a security boundary." },
  // ── money-events.ts (owner, 2026-11-25: stays enforced) ─────────────────────────────────────────────────────────────
  "money.veto": { file: `${CORE}/money-events.ts`, kind: "money", mode: "enforce",
    what: "VETO words in a money mail's subject or amount line (request, hold, statement, failed, 预授权, 账单…) keep it out of the books.",
    readers: "moneyEventFromMail, moneySubjectVetoed (the bookkeeping and its repair).",
    retire: "Not retired: the owner keeps the bookkeeping's veto enforced (2026-11-25). Telemetry only counts how often it overrules the triage." },
  "money.amount-label": { file: `${CORE}/money-events.ts`, kind: "money", mode: "enforce",
    what: "Which label an amount stands beside: totals (合计/实付/amount charged) vs. subtotal/tax/balance/积分.",
    readers: "moneyEventFromMail (the amount must be found where the mail states the total).",
    retire: "Not retired (bookkeeping, owner's decision of 2026-11-25)." },
  "money.merchant-key": { file: `${CORE}/money-events.ts`, kind: "money", mode: "enforce",
    what: "merchantKey: processor prefixes (支付宝-, PAYPAL *) and company noise (有限公司, inc) stripped from a merchant name.",
    readers: "matchScore (whether two pieces of evidence are one transaction).",
    retire: "Not retired (bookkeeping, owner's decision of 2026-11-25)." },
  "money.refund-words": { file: `${CORE}/money-events.ts`, kind: "money", mode: "enforce",
    what: "REFUND_WORDS / REFUND_OK: 退款, refund; 取消 does not veto a refund.",
    readers: "The bookkeeping's refund matching and repair.",
    retire: "Not retired (bookkeeping, owner's decision of 2026-11-25)." },
  // ── rough-dates.ts ───────────────────────────────────────────────────────────────────────────────────────────────────
  "rough.window": { file: `${CORE}/rough-dates.ts`, kind: "evidence", mode: "enforce",
    what: "roughWindow: the window of days 「下周」「11 月底前」「这学期内」「两周内」 name.",
    readers: "The date check (a model's day must lie in the person's words), settleRoughDay.",
    retire: "Verification of a model's claim: kept while dates are taken from the person's replies." },
  "rough.starts-words": { file: `${CORE}/rough-dates.ts`, kind: "semantic", mode: "enforce",
    what: "STARTS_WORDS (开始/着手/start…): a rough window is a start, so its first day, not its last.",
    readers: "settleRoughDay, date-schema's settle of a dated item or fact.",
    retire: "The dating Skills return `role: start|end` on each date; then settleRoughDay reads the field and the word list goes." },
  // ── activity-state.ts ────────────────────────────────────────────────────────────────────────────────────────────────
  "activity.private-window": { file: `${CORE}/activity-state.ts`, kind: "invariant", mode: "enforce",
    what: "isPrivateWindow: banking, password managers, private browsing, 验证码 — a window never recorded.",
    readers: "The activity recorder (before anything is stored).",
    retire: "Never: a privacy boundary, deliberately broad." },
  "activity.category": { file: `${CORE}/activity-state.ts`, kind: "semantic", mode: "enforce",
    what: "classifyWindow's title words (bilibili/草稿/收件箱/腾讯会议…) when the app is a browser or unknown.",
    readers: "The work-state reading, 拟计时 (time drafts), the activity chart.",
    retire: "Runs every few seconds on device on raw titles, so not a model call; retire if a local classifier replaces it or the person's own rules cover >90% of browser minutes." },
  // ── agent-failure.ts ─────────────────────────────────────────────────────────────────────────────────────────────────
  "agent-failure.external-words": { file: `${CORE}/agent-failure.ts`, kind: "semantic", mode: "enforce",
    what: "A stopped run's message read for a captcha, a login, a payment or sending (and 网站/读取 for a site stop).",
    readers: "classifyAgentFailure → whether a run is retried and what the card says the person must do.",
    retire: "The runner's result carries a structured stop reason from the model (`stoppedBy: captcha|login|payment|outward`), read instead of the message." },
  "agent-failure.needs-input": { file: `${CORE}/agent-failure.ts`, kind: "semantic", mode: "enforce",
    what: "NEEDS_INPUT: 缺少/请提供/无法确定 in a stop message means the person must supply something.",
    readers: "classifyAgentFailure (needs_input vs. hard).",
    retire: "Same structured stop reason as agent-failure.external-words (`needs_input`)." },
  "agent-failure.keep-workflow": { file: `${CORE}/agent-failure.ts`, kind: "semantic", mode: "enforce",
    what: "A growing run's 「保留这个工作流」 left for the person is not a reason to ask.",
    readers: "resultNeedsPerson.",
    retire: "The agent's summary schema marks a needs-human item's kind (`keep_workflow`)." },
  // ── importance.ts ────────────────────────────────────────────────────────────────────────────────────────────────────
  "importance.hours-from-text": { file: `${CORE}/importance.ts`, kind: "evidence", mode: "enforce",
    what: "hoursFromText: 「每周约 12 小时」「10–20 小时」 as a number of hours.",
    readers: "plan-stats' stated shares (the person's own weekly hours per line).",
    retire: "The interview stores weekly hours as a number slot; then the facts are read as numbers." },
  // ── interview-rules.ts ───────────────────────────────────────────────────────────────────────────────────────────────
  "interview.record": { file: `${CORE}/interview-rules.ts`, kind: "semantic", mode: "record",
    what: "The interview's record-only checks (verdict \"record\" in INTERVIEW_RULES: IR-006, IR-014, IR-047, IR-051, IR-123's disclosure half, IR-124, IR-126's repeat, IR-165, IR-190, IR-191); the line's `rule` names which.",
    readers: "None at run time; the interview replays count them (docs/claude/profile-first-loop.md).",
    retire: "Each IR rule retires on its own status in INTERVIEW_RULES; this entry goes when no record-only IR rule is left." },
  // ── profile-gaps.ts ──────────────────────────────────────────────────────────────────────────────────────────────────
  "profile-gaps.weekly-skip": { file: `${CORE}/profile-gaps.ts`, kind: "semantic", mode: "enforce",
    what: "An undated item titled 每周/weekly recurs, so no 「大致日期」 question.",
    readers: "profileGaps (which questions the interview asks).",
    retire: "Undated items carry the extraction's `recurring` flag." },
  "profile-gaps.undated-key": { file: `${CORE}/profile-gaps.ts`, kind: "style", mode: "enforce",
    what: "undatedKey: 提交/截止/due and course codes removed so one item under three wordings is asked once.",
    readers: "profileGaps, answered undated facts.",
    retire: "Undated items carry a stable id from the extraction." },
  "profile-gaps.inferred-prefix": { file: `${CORE}/profile-gaps.ts`, kind: "style", mode: "enforce",
    what: "推断：/假设： stripped from an inferred deadline before it is offered.",
    readers: "The deadline question's 「按访谈推断」 option.",
    retire: "Inferred facts are stored without the prefix." },
  "profile-gaps.varies": { file: `${CORE}/profile-gaps.ts`, kind: "evidence", mode: "enforce",
    what: "不固定/看情况/varies in the person's answer about class times is an answer.",
    readers: "Whether the meeting-time question is still open.",
    retire: "The answer is a chosen option (「不固定」) rather than typed text." },
  "profile-gaps.states-day": { file: `${CORE}/profile-gaps.ts`, kind: "evidence", mode: "enforce",
    what: "statesDay/statesTime: typed text under 「我来写日期」 says a day or a time (月/周一/上午/a rough window) before it is written as a fact.",
    readers: "answeredGapFacts (what becomes a confirmed fact).",
    retire: "A date picker replaces free text for these answers." },
  "profile-gaps.no-deadline": { file: `${CORE}/profile-gaps.ts`, kind: "evidence", mode: "enforce",
    what: "NO_DEADLINE: 没有截止/no deadline typed under the app's own deadline question is an answer (IR-015).",
    readers: "answeredGapFacts (whether 「没有截止」 is written as the fact).",
    retire: "The deadline question offers 「没有截止」 as an option, so the answer is a pick rather than typed text." }
} as const satisfies Record<string, RuleSpec>;
// i18n-ignore-end

export type RuleId = keyof typeof RULE_SPEC;
export const RULE_IDS = Object.keys(RULE_SPEC) as RuleId[];
export const isRuleId = (value: string): value is RuleId => Object.prototype.hasOwnProperty.call(RULE_SPEC, value);

/** Rules whose mode no override changes. */
export const ruleLocked = (id: RuleId) => RULE_SPEC[id].kind === "invariant" || RULE_SPEC[id].kind === "money";

// ── Run-time mode ──────────────────────────────────────────────────────────────────────────────────────────────────────

const RULE_MODES: readonly RuleMode[] = ["enforce", "record", "fallback"];
let overrides: Partial<Record<RuleId, RuleMode>> = {};
let envSeen: string | undefined;
let envModes: Partial<Record<RuleId, RuleMode>> = {};

/** `id=mode,id=mode` as overrides; unknown ids and modes are ignored. */
export function parseRuleModes(text: string | undefined): Partial<Record<RuleId, RuleMode>> {
  const out: Partial<Record<RuleId, RuleMode>> = {};
  for (const part of (text ?? "").split(",")) {
    const [id, mode] = part.split("=").map((item) => item.trim());
    if (id && mode && isRuleId(id) && (RULE_MODES as readonly string[]).includes(mode)) out[id] = mode as RuleMode;
  }
  return out;
}

const envOverrides = (): Partial<Record<RuleId, RuleMode>> => {
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.CROSSLINE_RULE_MODE;
  if (raw !== envSeen) { envSeen = raw; envModes = parseRuleModes(raw); }
  return envModes;
};

/** Sets the in-process overrides (an ablation run); `undefined` clears them. The environment's still apply under them. */
export function setRuleModes(next: Partial<Record<RuleId, RuleMode>> | undefined): void { overrides = { ...(next ?? {}) }; }

/** The mode a rule runs in now: an override (not for invariant or money rules), else its registered mode. */
export function ruleMode(id: RuleId): RuleMode {
  if (ruleLocked(id)) return RULE_SPEC[id].mode;
  return overrides[id] ?? envOverrides()[id] ?? RULE_SPEC[id].mode;
}

/** Whether the rule's verdict is used (enforce or fallback); under `record` it is only logged. */
export const ruleApplies = (id: RuleId) => ruleMode(id) !== "record";

// ── Telemetry ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One firing: which rule, in which mode, whether its verdict was used, and a short detail (no personal text beyond a 120-char sample). */
export type RuleFiredLine = { type: "rule.fired"; at: string; id: RuleId; kind: RuleKind; mode: RuleMode; applied: boolean } & Record<string, string | number | boolean>;
export type RuleFiredDetail = { key?: string | undefined; verdict?: string | undefined; sample?: string | undefined } & Record<string, string | number | boolean | undefined>;
type Sink = (line: RuleFiredLine) => void;

let sink: Sink | undefined;
const seen = new Set<string>();
const SEEN_MAX = 10_000;

/** Where firings go: the worker and the web server install a JSONL file sink (`rule-telemetry.ts` in packages/db); none in the browser. */
export function setRuleSink(next: Sink | undefined): void { sink = next; seen.clear(); }

/**
 * Records that a rule decided something. With `detail.key`, the same rule and key is recorded once per process (a title read on every
 * render is one firing). Never throws: telemetry is never a reason to fail.
 */
export function ruleFired(id: RuleId, detail: RuleFiredDetail = {}, now = new Date()): void {
  if (!sink) return;
  if (detail.key !== undefined) {
    const mark = `${id}|${detail.key}`;
    if (seen.has(mark)) return;
    if (seen.size >= SEEN_MAX) seen.clear();
    seen.add(mark);
  }
  const mode = ruleMode(id);
  const extra: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(detail)) {
    if (value === undefined) continue;
    extra[name] = typeof value === "string" ? value.slice(0, name === "sample" ? 120 : 200) : value;
  }
  try {
    sink({ ...extra, type: "rule.fired", at: now.toISOString(), id, kind: RULE_SPEC[id].kind, mode, applied: mode !== "record" });
  } catch { /* the log is for reading, never a reason to fail */ }
}
