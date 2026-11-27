/**
 * Execution gates judged by a model (docs/plans/execution-gates-1124.md, 2026-11-24). A gate is one Skill run that reads evidence and
 * returns a verdict in one shared envelope; code only gathers the evidence, runs the model, records the judgement and shows it. Business
 * thresholds (a share of planning time, "about three hours") live in the Skills as goal descriptions, not here (the owner, round 3: no new
 * hard-coded checks — branches, loops and prompts instead). What code does decide: whether two runs of one judgement disagree, and
 * whether a judgement needs the person, both by plain comparison of what the model said.
 */
import { readSourceFolders, SOURCE_FOLDERS_SETTING } from "./source-folders";

/**
 * Every judgement: one event. Its entity is what was judged (a task, a milestone, a week, a drill). The person turning one over is a
 * `gate.changed` `overridden` (entity: the overturned `gate.judged` event id); saying it was right, `gate.changed` `confirmed`.
 */
export const GATE_JUDGED = "gate.judged";

export type GateId =
  /** J1: is the task done, submitted, waiting on someone, or still planned — from evidence alone. */
  | "completion"
  /** J1a: this week's P1 and outward-facing tasks. */
  | "priority"
  /** J2a: may a new milestone open now, or wait (parked). */
  | "admission"
  /** J2b: a setback is a wrong goal, a wrong execution, or noise. */
  | "setback"
  /** J3: where the week's attention went. */
  | "attention"
  /** J4: today's small outside gate, put first. */
  | "front"
  /** J6: an outward action at night is reversible or not. */
  | "night"
  /** J7: grading the week's bug-finding drill. */
  | "drill";

/**
 * Everything that differs between gates, in one place; the runner, the asks, the override menu and the review read it from here.
 * - `code`: the name the person's own documents use (J1–J7).
 * - `verdicts`: the gate's own verdicts besides `cannot_judge`; its schema and the override menu are built from them.
 * - `dual`: which subjects are judged a second time with the evidence reversed — all, only those the pass flags (P1 / outward), or none.
 * - `asks`: whether a judgement of this gate can be put to the person on 待确认 at all (J3 and J6 are read in the weekly review, J4 on
 *   Today with its own 「不是这件」, J7 in its own block).
 * - `askOn`: verdicts always put to the person, because acting on them wrongly would drop or redirect work (§四 J2a/J2b).
 */
export type GateSpec = { code: string; label: string; verdicts: readonly string[]; dual: "all" | "flagged" | "none"; asks: boolean; askOn: readonly string[] };
/* i18n-ignore-start: Chinese labels, translated where shown */
export const GATE_SPEC: Record<GateId, GateSpec> = {
  completion: { code: "J1", label: "完成判定", verdicts: ["done", "submitted", "waiting", "planned"], dual: "flagged", asks: true, askOn: [] },
  priority: { code: "J1a", label: "P1 标注", verdicts: ["p1_external", "p1", "external", "normal"], dual: "none", asks: true, askOn: [] },
  admission: { code: "J2a", label: "里程碑准入", verdicts: ["admit", "park", "decline"], dual: "all", asks: true, askOn: ["decline"] },
  setback: { code: "J2b", label: "挫折分类", verdicts: ["goal_wrong", "execution_wrong", "noise"], dual: "all", asks: true, askOn: ["goal_wrong", "execution_wrong"] },
  attention: { code: "J3", label: "注意力审计", verdicts: ["crowded_out", "not_crowded"], dual: "none", asks: false, askOn: [] },
  front: { code: "J4", label: "外部小关口", verdicts: ["front", "none"], dual: "none", asks: false, askOn: [] },
  night: { code: "J6", label: "深夜操作", verdicts: ["reversible", "irreversible"], dual: "none", asks: false, askOn: [] },
  drill: { code: "J7", label: "找错练习", verdicts: ["graded"], dual: "none", asks: false, askOn: [] }
};
/* i18n-ignore-end */
export const GATE_IDS = Object.keys(GATE_SPEC) as GateId[];
const specColumn = <K extends keyof GateSpec>(key: K) => Object.fromEntries(GATE_IDS.map((gate) => [gate, GATE_SPEC[gate][key]])) as Record<GateId, GateSpec[K]>;
export const GATE_CODE = specColumn("code");
export const GATE_LABEL = specColumn("label");
/** Each gate's own verdicts (besides `cannot_judge`), for its schema and the override menu. */
export const GATE_VERDICTS = specColumn("verdicts");

/** J1a's verdicts read as labels. */
export const PRIORITY_LABELS: Record<string, { p1: boolean; external: boolean }> = {
  p1_external: { p1: true, external: true }, p1: { p1: true, external: false }, external: { p1: false, external: true }, normal: { p1: false, external: false }
};

/** The person's own statement of what they work toward (their objective and this period's action list), pasted in Settings. */
export const GATE_GOAL_SETTING = "gates.goal";
/** How much of it is kept and sent: a context budget. */
export const GATE_GOAL_MAX_CHARS = 6000;

/** The person's night (their rule, round 3): an hour `h` with `from <= h < until`, in their own zone. */
export const NIGHT_HOURS = { from: 1, until: 6 } as const;

/** J3's classes of attention. */
export const ATTENTION_CLASSES = ["execution", "outside_gate", "meta", "other"] as const;
export type AttentionClass = typeof ATTENTION_CLASSES[number];

/** The states of a task that is still to be done (shown on the board, not finished, not archived). */
export const OPEN_TASK_STATES: ReadonlySet<string> = new Set(["approved", "preparing", "ready_for_human", "active", "evidence_review"]);

export type GateConfidence = "high" | "medium" | "low";
/** What it costs when the judgement is wrong (attention ledger §7.1's fields): what decides whether the person is asked. */
export type GateHarm = "none" | "quality" | "deadline" | "external";
export type GateFixable = "before_step" | "after_submit" | "never";
export type GateEvidenceKind = "event" | "file" | "mail" | "commit" | "activity" | "calendar" | "task" | "web";
export type GateEvidence = { kind: GateEvidenceKind; ref: string; quote: string; at: string };

/** The envelope every gate Skill returns; `detail` is the gate's own. */
export type GateOutput<D = Record<string, unknown>> = {
  verdict: string;
  confidence: GateConfidence;
  evidence: GateEvidence[];
  reason: string;
  ifWrong: { harm: GateHarm; fixable: GateFixable };
  detail: D;
};

export const CANNOT_JUDGE = "cannot_judge";

const str = { type: "string" } as const;
const EVIDENCE_SCHEMA = {
  type: "array", items: { type: "object", additionalProperties: false, required: ["kind", "ref", "quote", "at"],
    properties: { kind: { type: "string", enum: ["event", "file", "mail", "commit", "activity", "calendar", "task", "web"] }, ref: str, quote: str, at: str } }
} as const;

/** One judgement's JSON schema: the envelope with the gate's verdicts (plus `cannot_judge`) and its own `detail`. */
export function gateItemSchema(verdicts: readonly string[], detail: Record<string, unknown>) {
  return {
    type: "object", additionalProperties: false, required: ["verdict", "confidence", "evidence", "reason", "ifWrong", "detail"],
    properties: {
      verdict: { type: "string", enum: [...verdicts, CANNOT_JUDGE] },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      evidence: EVIDENCE_SCHEMA,
      reason: str,
      ifWrong: { type: "object", additionalProperties: false, required: ["harm", "fixable"], properties: {
        harm: { type: "string", enum: ["none", "quality", "deadline", "external"] }, fixable: { type: "string", enum: ["before_step", "after_submit", "never"] } } },
      detail
    }
  } as const;
}

/** A batch: one judgement per subject, `subject` copied from the input. */
export function gateBatchSchema(verdicts: readonly string[], detail: Record<string, unknown>) {
  const item = gateItemSchema(verdicts, detail);
  return {
    type: "object", additionalProperties: false, required: ["items"],
    properties: { items: { type: "array", items: { ...item, required: ["subject", ...item.required], properties: { subject: str, ...item.properties } } } }
  } as const;
}

/** A gate's batch schema, its verdicts taken from `GATE_SPEC`. */
export const gateSchema = (gate: GateId, detail: Record<string, unknown>): Record<string, unknown> => gateBatchSchema(GATE_SPEC[gate].verdicts, detail) as unknown as Record<string, unknown>;

/** `form`: a registration form Crossline is about to submit (J6); `action`: something the person did or that happened to them. */
export type GateSubject = { kind: "task" | "milestone" | "week" | "day" | "drill" | "opportunity" | "action" | "form"; id: string };

export type GateJudgedPayload = {
  gate: GateId;
  subject: GateSubject;
  /** `run` 2 is the same judgement with the evidence in reverse order (round 1: one model, order swapped). */
  run: 1 | 2;
  /** On run 2: whether its verdict differs from run 1's. */
  disagrees?: boolean;
  pairedWith?: string;
  model: string;
  effort: string;
  promptVersion: string;
  /** sha256 of the prepared input and one line on what it held; the input itself is not kept (mail text is never stored). */
  inputDigest: { sha256: string; summary: string };
  output: GateOutput;
  /** Whether the judgement was put to the person (`gate_check`). */
  asked: boolean;
  /** Arithmetic the code did on the model's answer (J3: hours summed from the model's class for each block); never a judgement. */
  computed?: Record<string, unknown>;
};

export type GateOverriddenPayload = { judgedId: string; gate: GateId; subject: GateSubject; from: string; to: string; note?: string };

/** Two runs of one judgement disagree when their verdicts differ. */
export const gateRunsDisagree = (a: Pick<GateOutput, "verdict">, b: Pick<GateOutput, "verdict">) => a.verdict !== b.verdict;

/**
 * Whether the person is asked (§7.1, round 1), for a gate whose judgements may be asked at all: when the two runs disagree, when the
 * verdict is one of the gate's `askOn`, or when being wrong costs a deadline or has outside consequences that cannot be put right before
 * the step. Everything else is recorded and shown in the weekly review, where it can be turned over.
 */
export function gateNeedsPerson(gate: GateId, output: Pick<GateOutput, "ifWrong" | "verdict">, disagrees: boolean): boolean {
  const spec = GATE_SPEC[gate];
  if (!spec.asks) return false;
  if (disagrees) return true;
  if (output.verdict === CANNOT_JUDGE) return false;
  if (spec.askOn.includes(output.verdict)) return true;
  return (output.ifWrong.harm === "external" || output.ifWrong.harm === "deadline") && output.ifWrong.fixable !== "before_step";
}

/**
 * One run of a gate's model call (`runGate`), kept so a failing call is not repeated on every tick: `ok` false when the model gave no
 * answer, and `missing` the subjects an answer left out. A progress tick, not a ledger event: the worker keeps it in the
 * `gate-attempts` JSONL log (packages/db/src/rule-telemetry.ts) since 2026-11-27.
 */
export type GateAttemptedPayload = { gate: GateId; round: string; subjects: string[]; ok: boolean; missing: string[] };
/** How many failed attempts a subject gets in a day before its gate leaves it until the next day: a spending bound, not a judgement. */
export const GATE_FAILED_ATTEMPTS_PER_DAY = 3;

/** Subjects of `gate` that failed `GATE_FAILED_ATTEMPTS_PER_DAY` times in the last day (no answer, or left out of one). */
export function gateExhausted(attempts: readonly GateAttempt[], gate: GateId, now: Date): Set<string> {
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const failures = new Map<string, number>();
  for (const attempt of attempts) {
    if (attempt.at < since) continue;
    const payload = attempt.payload as GateAttemptedPayload;
    if (payload.gate !== gate) continue;
    for (const id of payload.ok ? payload.missing : payload.subjects) failures.set(id, (failures.get(id) ?? 0) + 1);
  }
  return new Set([...failures].filter(([, count]) => count >= GATE_FAILED_ATTEMPTS_PER_DAY).map(([id]) => id));
}

/**
 * The one way every gate decides what is left to judge: the candidates with no judgement of this gate (since `sinceIso`, when a subject
 * is judged again each period) that have not failed too often today.
 */
export function pendingGateSubjects(events: readonly EventLike[], gate: GateId, candidates: readonly string[], now: Date, sinceIso = "", attempts: readonly GateAttempt[] = []): string[] {
  const judged = new Set<string>();
  for (const event of events) {
    if (event.type === GATE_JUDGED && event.createdAt >= sinceIso && (event.payload as GateJudgedPayload).gate === gate) judged.add(event.entityId);
  }
  const exhausted = gateExhausted(attempts, gate, now);
  return candidates.filter((id) => !judged.has(id) && !exhausted.has(id));
}

type EventLike = { eventId: string; type: string; entityId: string; createdAt: string; payload: unknown };
/** One line of the `gate-attempts` log. */
export type GateAttempt = { at: string; payload: unknown };

export type GateJudgement = { eventId: string; at: string; payload: GateJudgedPayload; overridden?: { to: string; at: string; note?: string } };

/**
 * The latest judgement of each subject for one gate (run 1, or run 2 when it disagreed — the pair stands or falls together), with the
 * person's override when there is one. The verdict that counts is the override's `to`, else the model's.
 */
export function latestGateJudgements(events: readonly EventLike[], gate: GateId): Map<string, GateJudgement> {
  const overrides = new Map<string, { to: string; at: string; note?: string }>();
  for (const event of events) {
    if (!(event.type === "gate.changed" && (event.payload as { change?: string }).change === "overridden")) continue;
    const payload = event.payload as GateOverriddenPayload;
    overrides.set(payload.judgedId, { to: payload.to, at: event.createdAt, ...(payload.note ? { note: payload.note } : {}) });
  }
  const out = new Map<string, GateJudgement>();
  for (const event of events) {
    if (event.type !== GATE_JUDGED) continue;
    const payload = event.payload as GateJudgedPayload;
    if (payload.gate !== gate || payload.run !== 1) continue;
    const key = `${payload.subject.kind}:${payload.subject.id}`;
    const prior = out.get(key);
    if (prior && prior.at > event.createdAt) continue;
    const overridden = overrides.get(event.eventId);
    out.set(key, { eventId: event.eventId, at: event.createdAt, payload, ...(overridden ? { overridden } : {}) });
  }
  return out;
}

export const verdictOf = (judgement: GateJudgement) => judgement.overridden?.to ?? judgement.payload.output.verdict;

export type GateWeekStats = { gate: GateId; judged: number; cannotJudge: number; disagreed: number; asked: number; overridden: number; agreedButOverridden: number };

/**
 * The weekly review's 「关口」 row per gate: how often it judged, could not, disagreed with itself, asked, and was turned over — and how
 * often a pair that agreed was turned over anyway, the measure of what one model swapped twice cannot catch (round 1).
 */
export function gateWeekStats(events: readonly EventLike[], sinceIso: string, untilIso: string): GateWeekStats[] {
  const inWeek = (at: string) => at >= sinceIso && at < untilIso;
  const judged = new Map<string, GateJudgedPayload>();
  const disagreedPairs = new Set<string>();
  for (const event of events) {
    if (event.type !== GATE_JUDGED) continue;
    const payload = event.payload as GateJudgedPayload;
    judged.set(event.eventId, payload);
    if (payload.run === 2 && payload.disagrees && payload.pairedWith) disagreedPairs.add(payload.pairedWith);
  }
  const stats = new Map<GateId, GateWeekStats>(GATE_IDS.map((gate) => [gate, { gate, judged: 0, cannotJudge: 0, disagreed: 0, asked: 0, overridden: 0, agreedButOverridden: 0 }]));
  for (const event of events) {
    if (event.type === GATE_JUDGED && inWeek(event.createdAt)) {
      const payload = event.payload as GateJudgedPayload;
      if (payload.run !== 1) continue;
      const row = stats.get(payload.gate)!;
      row.judged += 1;
      if (payload.output.verdict === CANNOT_JUDGE) row.cannotJudge += 1;
      if (disagreedPairs.has(event.eventId)) row.disagreed += 1;
      if (payload.asked) row.asked += 1;
    }
    if ((event.type === "gate.changed" && (event.payload as { change?: string }).change === "overridden") && inWeek(event.createdAt)) {
      const payload = event.payload as GateOverriddenPayload;
      const row = stats.get(payload.gate);
      if (!row) continue;
      row.overridden += 1;
      const original = judged.get(payload.judgedId);
      if (original && !disagreedPairs.has(payload.judgedId) && original.run === 1) row.agreedButOverridden += 1;
    }
  }
  return [...stats.values()].filter((row) => row.judged || row.overridden);
}

/** sha256 is computed by the caller (node:crypto); this is the one-line summary of what an input held, for the record. */
export function inputSummary(counts: Record<string, number>): string {
  return Object.entries(counts).filter(([, count]) => count > 0).map(([key, count]) => `${key} ${count}`).join(", ");
}

/** J6 in the weekly review: forms Crossline was about to submit at night and how many it held; the person's own night actions. */
export function nightCounts(events: readonly EventLike[], sinceIso: string, untilIso: string) {
  let pending = 0, held = 0, own = 0, ownIrreversible = 0;
  for (const event of events) {
    if (event.type !== GATE_JUDGED || event.createdAt < sinceIso || event.createdAt >= untilIso) continue;
    const payload = event.payload as GateJudgedPayload;
    if (payload.gate !== "night" || payload.run !== 1) continue;
    if (payload.subject.kind === "form") { pending += 1; if (payload.output.verdict !== "reversible") held += 1; }
    else { own += 1; if (payload.output.verdict === "irreversible") ownIrreversible += 1; }
  }
  return { pending, held, own, ownIrreversible };
}

// ── Privacy, on the person's computer, before anything is sent (round 2, round 4: a safety boundary, not a check on results) ──

/** Words and file kinds that mark a process design kit or a foundry's files: never read, masked in titles. The person adds node names. */
export const PDK_TERMS_SETTING = "privacy.pdkTerms";
export const DEFAULT_PDK_TERMS: readonly string[] = [".lib", ".lef", ".def", ".gds", ".gds2", ".oas", ".spi", ".scs", ".cdl", ".tf", ".itf", ".tluplus", ".techlef", "pdk"];
export const LOCAL_ONLY_MASK = "[仅本地]"; // i18n-ignore: a mark put in place of private text, the same in every language

export function readPdkTerms(raw: string | undefined): string[] {
  let extra: unknown = [];
  try { extra = raw ? JSON.parse(raw) : []; } catch { extra = []; }
  const added = Array.isArray(extra) ? extra.filter((item): item is string => typeof item === "string").map((item) => item.trim().toLowerCase()).filter(Boolean) : [];
  return [...new Set([...DEFAULT_PDK_TERMS, ...added])];
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A term matches as a whole word or file extension, case aside: `.lib` in `cells.lib`, `pdk` in `gf180 PDK`, not `pdks` inside `updkx`. */
export function pdkHit(text: string, terms: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return terms.some((term) => {
    const pattern = term.startsWith(".") ? `${escapeRegex(term)}(?![a-z0-9])` : `(?<![a-z0-9])${escapeRegex(term)}(?![a-z0-9])`;
    return new RegExp(pattern).test(lower);
  });
}

/**
 * Text that names a folder the person marked local only (`SourceFolder.localOnly`): its full path, or its own name as a whole word (a
 * window title shows the folder's name, not its path). Names shorter than four characters match only as the full path.
 */
export function insideLocalOnly(text: string, localOnlyPaths: readonly string[]): boolean {
  const norm = (value: string) => value.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  const lower = norm(text);
  return localOnlyPaths.some((root) => {
    const full = norm(root);
    if (full.length > 2 && lower.includes(full)) return true;
    const name = full.split("/").at(-1) ?? "";
    return name.length >= 4 && new RegExp(`(?<![a-z0-9])${escapeRegex(name)}(?![a-z0-9])`).test(lower);
  });
}

export type PrivacyRules = { terms: readonly string[]; localOnlyPaths: readonly string[] };
/** The person's privacy settings as the masking reads them: PDK terms and the folders marked 「仅本地」. */
export function privacyRules(getSetting: (key: string) => string | undefined): PrivacyRules {
  return { terms: readPdkTerms(getSetting(PDK_TERMS_SETTING)),
    localOnlyPaths: readSourceFolders(getSetting(SOURCE_FOLDERS_SETTING)).filter((folder) => folder.localOnly).map((folder) => folder.path) };
}

/** A window title, file name or commit file list entry as it may leave the computer. */
export function maskPrivate(text: string, terms: readonly string[], localOnlyPaths: readonly string[]): string {
  return pdkHit(text, terms) || insideLocalOnly(text, localOnlyPaths) ? LOCAL_ONLY_MASK : text;
}

/**
 * J5, the estimate ratio (docs/plans/execution-gates-1124.md §四 J5): actual minutes over the model's own estimate for every task with
 * both in the last `days` days, censored ones left out. Shown in the weekly review and handed to J4 as the cost correction; no threshold
 * is applied here — the model reads it as evidence. `null` when nothing was measured.
 */
export type EstimateRatio = { median: number; p25: number; p75: number; n: number; since: string };
/** The window J5's ratio is read over (the weekly review says 「近四周」). */
export const ESTIMATE_RATIO_DAYS = 28;
export function estimateRatio(observations: ReadonlyArray<{ observedMinutes: number; llmP50Minutes: number | null; censored: boolean; observedAt: string }>,
  now: Date, days = ESTIMATE_RATIO_DAYS): EstimateRatio | null {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const ratios = observations.filter((item) => !item.censored && item.observedAt >= since && (item.llmP50Minutes ?? 0) > 0 && item.observedMinutes > 0)
    .map((item) => item.observedMinutes / item.llmP50Minutes!).sort((a, b) => a - b);
  if (!ratios.length) return null;
  const at = (q: number) => {
    const position = (ratios.length - 1) * q, low = Math.floor(position), high = Math.ceil(position);
    return Math.round((ratios[low]! + (ratios[high]! - ratios[low]!) * (position - low)) * 100) / 100;
  };
  return { median: at(0.5), p25: at(0.25), p75: at(0.75), n: ratios.length, since };
}

/** Today's pick for the web: the chosen task id and its cost of delay, the person's 「不是这件」 applied (an override to `none`). */
export function todaysFront(events: readonly EventLike[], day: string): { eventId: string; task: string; costOfDelay: string; minutes: number } | null {
  const judged = latestGateJudgements(events, "front").get(`day:${day}`);
  if (!judged || verdictOf(judged) !== "front") return null;
  const detail = judged.payload.output.detail as { task?: string; costOfDelay?: string; minutes?: number } | undefined;
  return detail?.task ? { eventId: judged.eventId, task: detail.task, costOfDelay: detail.costOfDelay ?? "", minutes: detail.minutes ?? 0 } : null;
}

/**
 * J2a's parking (docs/plans/execution-gates-1124.md §四 J2a): the milestones table allows no new status, so a parked milestone is a draft
 * with a `milestone.changed` `parked` event after its last approval and no `unparked` after that. A parked draft is never archived as
 * stale (date-advance), and the person is asked about it once a month.
 */
export type MilestoneParkedPayload = { milestoneId: string; judgedId: string; unparkWhen: string; reason: string; archivedTasks: string[] };
export function parkedMilestones(events: readonly EventLike[]): Map<string, MilestoneParkedPayload & { at: string }> {
  const out = new Map<string, MilestoneParkedPayload & { at: string }>();
  for (const event of [...events].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if ((event.type === "milestone.changed" && (event.payload as { change?: string }).change === "parked")) out.set(event.entityId, { ...(event.payload as MilestoneParkedPayload), at: event.createdAt });
    else if ((event.type === "milestone.changed" && (event.payload as { change?: string }).change === "unparked")) out.delete(event.entityId);
  }
  return out;
}

/* i18n-ignore-start: Chinese keys, translated where shown */
export const GATE_VERDICT_LABEL: Record<string, string> = {
  done: "已完成", submitted: "已提交", waiting: "在等别人", planned: "还没做", p1_external: "P1·对外", p1: "P1", external: "对外", normal: "一般",
  admit: "可以开", park: "先停放", decline: "不做", goal_wrong: "目标错了", execution_wrong: "做法错了", noise: "噪声", crowded_out: "被挤占",
  not_crowded: "没有被挤占", front: "今日首件", none: "今天没有", reversible: "可撤回", irreversible: "不可撤回", graded: "已评分", cannot_judge: "判断不了"
};
/* i18n-ignore-end */
