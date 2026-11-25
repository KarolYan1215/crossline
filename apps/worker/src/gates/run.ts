import { createHash, randomUUID } from "node:crypto";
import {
  GATE_ATTEMPTED, GATE_JUDGED, GATE_OVERRIDDEN, GATE_SPEC, gateExhausted, gateNeedsPerson, gateRunsDisagree, gateSchema,
  type GateAttemptedPayload, type GateId, type GateJudgedPayload, type GateOutput, type GateOverriddenPayload, type GateSubject
} from "@crossline/core";
import { routeForSkill, runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { ownerOf } from "../owner";
import { GATE_LIMITS, gateEventsOf } from "./context";

/**
 * One gate judgement, run once or twice (docs/plans/execution-gates-1124.md §四.0). The Skill answers a batch, one item per subject, in
 * the shared envelope; the JSON schema (the gate's verdicts from `GATE_SPEC` plus its own `detail`) is the only shape the runtime holds
 * it to (round 4: no other checks on the content). Subjects the gate's `dual` covers are judged a second time with the evidence in
 * reverse order; when the two verdicts differ, or `gateNeedsPerson` says so, the judgement is marked `asked` and the web puts it to the
 * person as a `gate_check`. Every call leaves a `gate.attempted`, so a call that keeps failing stops for the day instead of repeating on
 * every tick; a call that gives no answer at all throws `GateRunFailed`, so a pass never marks itself done on a failure.
 */
export type GateItem = GateOutput & { subject: string };
export type GateBatch = { items: GateItem[] };

export type GateRun<I> = {
  store: CrosslineStore;
  workspaceId: string;
  client: CodexRpcBoundary;
  cwd: string;
  gate: GateId;
  /** Without the `crossline:` prefix. */
  skill: string;
  promptVersion: string;
  input: I;
  /** The same input for the second run: only the `dual` subjects, every list of evidence in reverse order. */
  swap?: (input: I, dual: ReadonlySet<string>) => I;
  /** The gate's own `detail` schema; the envelope and the verdicts come from `GATE_SPEC`. */
  detail: Record<string, unknown>;
  /** Keyed by the id the model copies back. `flagged`: judged twice when the gate's `dual` is `flagged`. */
  subjects: Map<string, GateSubject & { flagged?: boolean }>;
  summary: string;
  stableKeys?: readonly string[];
  /** Idempotency: the same key for the same subject never writes twice (a re-judgement uses a new `round`). */
  round: string;
  developerInstructions?: string;
  /** Arithmetic on the model's answer kept beside it (`GateJudgedPayload.computed`), e.g. J3's hours from the model's classes. */
  computed?: (output: GateOutput) => Record<string, unknown>;
  timeoutMs?: number;
  now?: Date;
};

export type GateResult = { subject: GateSubject; eventId: string; output: GateOutput; disagrees: boolean; asked: boolean };

export class GateRunFailed extends Error {
  constructor(readonly gate: GateId) { super(`GATE_RUN_FAILED: ${gate}`); }
}

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export type GateCorrection = { subject: string; modelSaid: string; modelReason: string; personSaid: string; note?: string; at: string };

/**
 * The person's latest overrides of this gate (the weekly review shows them; this feeds them back). They go to the model as calibration
 * about how it misreads this person's evidence, never as evidence about the subjects now being judged.
 */
export function gateCorrections(store: CrosslineStore, workspaceId: string, gate: GateId): GateCorrection[] {
  const overrides = store.listEvents(workspaceId, { type: GATE_OVERRIDDEN }).filter((event) => (event.payload as GateOverriddenPayload).gate === gate)
    .slice(-GATE_LIMITS.correctionsPerCall);
  if (!overrides.length) return [];
  const judged = new Map(store.listEvents(workspaceId, { type: GATE_JUDGED }).map((event) => [event.eventId, event.payload as GateJudgedPayload]));
  return overrides.map((event) => {
    const payload = event.payload as GateOverriddenPayload;
    return { subject: `${payload.subject.kind}:${payload.subject.id}`, modelSaid: payload.from, modelReason: judged.get(payload.judgedId)?.output.reason ?? "",
      personSaid: payload.to, ...(payload.note ? { note: payload.note } : {}), at: event.createdAt };
  });
}

const CORRECTIONS_NOTE = " `corrections`, when present, lists the person's latest overrides of this gate's earlier verdicts: use them to recalibrate how you read"
  + " this person's evidence, never as evidence about the subjects judged now (what the person says is not evidence).";

async function runOnce<I>(spec: GateRun<I>, input: I, corrections: readonly GateCorrection[]): Promise<GateBatch | undefined> {
  const sent = corrections.length ? { ...input, corrections } : input;
  const result = await runCodexSkill<GateBatch>(spec.client, sent, {
    skillName: `crossline:${spec.skill}`, cwd: spec.cwd,
    developerInstructions: (spec.developerInstructions ?? `Judge every subject as the ${spec.skill} Skill describes, from the evidence given, and return only the requested JSON: one item per subject, \`subject\` copied from its id.`)
      + (corrections.length ? CORRECTIONS_NOTE : ""),
    outputSchema: gateSchema(spec.gate, spec.detail), prepareInput: () => sent, ...(spec.stableKeys ? { stableKeys: spec.stableKeys } : {}),
    validateOutput: (output) => output as GateBatch, onAudit: () => {}, timeoutMs: spec.timeoutMs ?? GATE_LIMITS.runTimeoutMs
  });
  return result.ok ? result.output : undefined;
}

function recordAttempt(spec: GateRun<unknown>, owner: string, run: 1 | 2, subjects: readonly string[], ok: boolean, missing: readonly string[]) {
  const payload: GateAttemptedPayload = { gate: spec.gate, round: `${spec.round}:${run}`, subjects: [...subjects], ok, missing: [...missing] };
  spec.store.appendEvent({ ownerId: owner, workspaceId: spec.workspaceId, type: GATE_ATTEMPTED, entityId: spec.gate,
    idempotencyKey: `${GATE_ATTEMPTED}:${spec.gate}:${spec.round}:${run}:${randomUUID()}`, payload });
}

export async function runGate<I>(spec: GateRun<I>): Promise<GateResult[]> {
  const now = spec.now ?? new Date();
  const owner = ownerOf(spec.store, spec.workspaceId);
  const exhausted = gateExhausted(gateEventsOf(spec.store, spec.workspaceId), spec.gate, now);
  const ids = [...spec.subjects.keys()];
  const subjectIds = (keys: readonly string[]) => keys.map((key) => spec.subjects.get(key)!.id);
  if (ids.every((id) => exhausted.has(spec.subjects.get(id)!.id))) return [];
  const corrections = gateCorrections(spec.store, spec.workspaceId, spec.gate);
  const first = await runOnce(spec, spec.input, corrections);
  if (!first) {
    recordAttempt(spec as GateRun<unknown>, owner, 1, subjectIds(ids), false, []);
    throw new GateRunFailed(spec.gate);
  }
  const answered = new Set(first.items.map((item) => item.subject));
  recordAttempt(spec as GateRun<unknown>, owner, 1, subjectIds(ids), true, subjectIds(ids.filter((id) => !answered.has(id))));

  const mode = GATE_SPEC[spec.gate].dual;
  const dual = new Set(mode === "none" || !spec.swap ? [] : ids.filter((id) => answered.has(id) && (mode === "all" || spec.subjects.get(id)!.flagged)));
  const second = dual.size ? await runOnce(spec, spec.swap!(spec.input, dual), corrections) : undefined;
  // A second run that gave no answer is not a disagreement: the first stands alone, and the attempt says so.
  if (dual.size && !second) recordAttempt(spec as GateRun<unknown>, owner, 2, subjectIds([...dual]), false, []);
  const secondBy = new Map((second?.items ?? []).map((item) => [item.subject, item]));
  const route = routeForSkill(spec.skill);
  const digest = { sha256: sha({ input: spec.input, corrections }), summary: `${spec.summary}${corrections.length ? `; corrections ${corrections.length}` : ""}` };
  const out: GateResult[] = [];
  const seen = new Set<string>();
  for (const item of first.items) {
    const subject = spec.subjects.get(item.subject);
    if (!subject || seen.has(item.subject)) continue;
    seen.add(item.subject);
    const { subject: _id, ...output } = item;
    const pair = second && dual.has(item.subject) ? secondBy.get(item.subject) : undefined;
    // A dual subject the second run (which did answer) left out counts as a disagreement: the pair could not confirm itself.
    const disagrees = second && dual.has(item.subject) ? !pair || gateRunsDisagree(output, pair) : false;
    const asked = gateNeedsPerson(spec.gate, output, disagrees);
    const base = { gate: spec.gate, subject: { kind: subject.kind, id: subject.id }, model: route?.model ?? "runtime-default", effort: route?.effort ?? "",
      promptVersion: spec.promptVersion, inputDigest: digest };
    const firstPayload: GateJudgedPayload = { ...base, run: 1, output, asked, ...(spec.computed ? { computed: spec.computed(output) } : {}) };
    const written = spec.store.appendEvent({ ownerId: owner, workspaceId: spec.workspaceId, type: GATE_JUDGED, entityId: subject.id,
      idempotencyKey: `${GATE_JUDGED}:${spec.gate}:${subject.kind}:${subject.id}:${spec.round}:1`, payload: firstPayload });
    if (pair) {
      const { subject: _pid, ...pairOutput } = pair;
      const secondPayload: GateJudgedPayload = { ...base, run: 2, output: pairOutput, asked, disagrees, pairedWith: written.eventId };
      spec.store.appendEvent({ ownerId: owner, workspaceId: spec.workspaceId, type: GATE_JUDGED, entityId: subject.id,
        idempotencyKey: `${GATE_JUDGED}:${spec.gate}:${subject.kind}:${subject.id}:${spec.round}:2`, payload: secondPayload });
    }
    if (written.inserted) out.push({ subject: base.subject, eventId: written.eventId, output, disagrees, asked });
  }
  return out;
}

/** Reverses the `evidence` array of every element of `list` (the second run's order). */
export const reverseEvidence = <T extends { evidence: unknown[] }>(list: readonly T[]): T[] => list.map((item) => ({ ...item, evidence: [...item.evidence].reverse() }));
