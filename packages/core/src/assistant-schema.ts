import { pathIsContained, TEXT_MEDIA_TYPES, PREFIX_THE_APP_OWNS, TOTAL_CONTENT_LIMIT } from "./materials-schema";
import { validateSuccessCriteria, type SuccessCriterion } from "./index";
import { criterion as criterionSchema } from "./milestone-gate-schema";
import type { MilestoneTemplateKind } from "./milestone-templates";

/**
 * What the site-wide floating assistant is allowed to return for one turn. Reused plumbing throughout
 * (see `apps/worker/src/assistant-runner.ts`): the same thread-based `runCodexSkill`/`continueSkillTurn`
 * every other conversational Skill in this app already uses, the same read-only/untrusted sandbox, the
 * same strict-schema convention.
 *
 * The one new capability this Skill has — generating a code snippet or script and saving it as a task
 * material — is deliberately narrow and structural, not just prompted for: the *only* way a turn can
 * produce something savable is by filling `materialDraft`, a plain data field the model can only ever
 * fill with validated JSON (the sandbox rejects every tool-call item, so it can never touch a file
 * directly), and the deterministic layer (`persistAssistantMaterial`) is the only thing that ever
 * actually writes it to disk, confined to the same `.crossline-materials/<workOrderId>/` root every other
 * material write already uses. There is no field, no tool and no code path here that reads or writes
 * this app's own repository.
 */
export type AssistantTurnContext = {
  version: "crossline.assistant.v1";
  history: Array<{ from: "user" | "assistant"; text: string }>;
  message: string;
  attachments: Array<{ id: string; fileName: string; mediaType: string }>;
  /** Present only when this conversation is scoped to one task — `materialDraft` may only be filled
   * when this is non-null, since a saved artifact has to belong to some work order's materials folder. */
  workOrderId: string | null;
  /** The identities `templateProposal.identityId` may name — same list `crossline-milestone-architect`
   * is offered, so a template the assistant adds on the user's request lands on a real identity. */
  identities: string[];
  /**
   * What the app knows about the person right now — today, milestones and deadlines, this week's plan
   * and calendar, what waits for a decision, confirmed facts (`apps/web/lib/person-snapshot.ts`). Rebuilt
   * and resent on every turn, follow-ups included, so a long conversation never runs on a stale or
   * compacted-away picture. Data to quote, never instructions.
   */
  snapshot: string;
};

/** Something the person may want done, offered as a card they confirm. The assistant itself writes nothing. */
export type AssistantProposalCard = {
  kind: "capture";
  /** The task as the person would type it into 快速收集. */
  title: string;
  /** Extra context for the analysis; empty when there is none. */
  context: string;
};

export type AssistantTurnProposal = {
  reply: string;
  /**
   * What the person corrected about how the system works for them (「这类作业我一般先看讲义」, 「这个任务分错类了，是写作」),
   * recorded as personal preferences at once; one about the task in view also replans its steps with the correction as feedback.
   */
  corrections?: Array<{ scope: string; text: string; taskId: string }>;
  /** Codex-style quick-reply suggestions shown as buttons under the reply; empty is normal for a turn
   * that is just answering something, not asking a follow-up. */
  quickReplies: string[];
  materialDraft: { relativePath: string; content: string; mediaType: string; sourceRefs: string[] } | null;
  /** Filled only when the person explicitly asked, in this conversation, for a new milestone template —
   * see 工作块 D. Unlike a milestone or relation proposal this is not a draft needing a second approval
   * step: the person asked for it directly, the same as if they had filled in the template-management
   * form themselves, so `assistant-runner.ts` saves it immediately with `source:"assistant"`. */
  templateProposal: {
    identityId: string; kind: MilestoneTemplateKind; titleHint: string; successCriteriaDefaults: SuccessCriterion[];
  } | null;
  /** Cards the person confirms with one click (for now: a capture). Empty for a plain answer. */
  proposals: AssistantProposalCard[];
  blockers: Array<{ code: string; message: string }>;
};

const str = { type: "string", minLength: 1, maxLength: 4000 } as const;
const longStr = { type: "string", minLength: 1, maxLength: 200_000 } as const;
const shortStr = { type: "string", minLength: 1, maxLength: 400 } as const;
const object = (properties: Record<string, unknown>) =>
  ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

export const ASSISTANT_OUTPUT_SCHEMA = object({
  reply: str,
  quickReplies: { type: "array", maxItems: 4, items: shortStr },
  materialDraft: {
    anyOf: [
      { type: "null" },
      object({
        relativePath: shortStr, content: longStr, mediaType: shortStr,
        // Unlike the material preparer's own contract (`materials-schema.ts`), a draft born mid-chat has
        // no research citations to demand — it is the direct product of this conversation, not an
        // externally-sourced claim, so an empty list is legitimate rather than a red flag.
        sourceRefs: { type: "array", maxItems: 20, items: shortStr }
      })
    ]
  },
  templateProposal: {
    anyOf: [
      { type: "null" },
      object({
        identityId: shortStr,
        kind: { type: "string", enum: ["deliverable", "threshold", "validation", "recurring_cadence", "decision"] },
        titleHint: shortStr,
        successCriteriaDefaults: { type: "array", minItems: 1, maxItems: 10, items: criterionSchema }
      })
    ]
  },
  proposals: { type: "array", maxItems: 3, items: object({
    kind: { type: "string", enum: ["capture"] },
    title: { type: "string", minLength: 1, maxLength: 240 },
    context: { type: "string", minLength: 0, maxLength: 500 }
  }) },
  corrections: { type: "array", maxItems: 3, items: object({
    scope: { type: "string", minLength: 1, maxLength: 80 },
    text: { type: "string", minLength: 4, maxLength: 300 },
    taskId: { type: "string", minLength: 0, maxLength: 128 }
  }) },
  blockers: { type: "array", maxItems: 5, items: object({ code: shortStr, message: shortStr }) }
});

export function validateAssistantTurnProposal(value: unknown, context: AssistantTurnContext): AssistantTurnProposal {
  const raw = value as AssistantTurnProposal | undefined;
  // An answer recorded before cards existed has none; every live answer carries the field (strict schema).
  const proposals = Array.isArray((raw as { proposals?: unknown } | undefined)?.proposals) ? raw!.proposals : [];
  if (!raw || typeof raw.reply !== "string" || !Array.isArray(raw.quickReplies) || !Array.isArray(raw.blockers)) {
    throw new Error("ASSISTANT_SCHEMA_INVALID");
  }
  if (raw.blockers.length) {
    const error = new Error("ASSISTANT_BLOCKED");
    (error as Error & { detail?: string }).detail =
      raw.blockers.map((blocker) => blocker.message.trim()).filter(Boolean).join("；").slice(0, 400);
    throw error;
  }
  if (raw.materialDraft) {
    if (!context.workOrderId) throw new Error("ASSISTANT_MATERIAL_REQUIRES_WORK_ORDER");
    const draft = raw.materialDraft;
    if (!pathIsContained(draft.relativePath)) throw new Error("ASSISTANT_MATERIAL_PATH_OUTSIDE_ROOT");
    if (PREFIX_THE_APP_OWNS.test(draft.relativePath)) throw new Error("ASSISTANT_MATERIAL_PATH_REPEATS_ROOT");
    if (!TEXT_MEDIA_TYPES.has(draft.mediaType)) throw new Error("ASSISTANT_MATERIAL_MEDIA_TYPE_UNSUPPORTED");
    if (draft.content.length > TOTAL_CONTENT_LIMIT) throw new Error("ASSISTANT_MATERIAL_TOO_LARGE");
  }
  if (raw.templateProposal) {
    const proposal = raw.templateProposal;
    if (!context.identities.includes(proposal.identityId)) throw new Error("ASSISTANT_TEMPLATE_IDENTITY_UNKNOWN");
    if (!proposal.titleHint.trim()) throw new Error("ASSISTANT_TEMPLATE_TITLE_REQUIRED");
    const checked = validateSuccessCriteria(proposal.successCriteriaDefaults);
    if (!checked.ok) throw new Error(checked.blocker.code);
  }
  for (const card of proposals) {
    if (card?.kind !== "capture" || typeof card.title !== "string" || !card.title.trim() || card.title.length > 240
      || typeof card.context !== "string" || card.context.length > 500) throw new Error("ASSISTANT_PROPOSAL_INVALID");
  }
  // A correction is kept, never refused: a scope that is not a line or an archetype becomes `all`, and only the task in view may be
  // replanned from it.
  const corrections = (Array.isArray((raw as { corrections?: unknown }).corrections) ? raw.corrections ?? [] : [])
    .filter((item) => item && typeof item.text === "string" && item.text.trim().length >= 4).slice(0, 3)
    .map((item) => ({ scope: context.identities.includes(item.scope) || /^archetype:[a-z_]+$/.test(item.scope) ? item.scope : "all",
      text: item.text.trim().slice(0, 300), taskId: item.taskId && item.taskId === context.workOrderId ? item.taskId : "" }));
  return {
    reply: raw.reply, quickReplies: raw.quickReplies, materialDraft: raw.materialDraft ?? null,
    templateProposal: raw.templateProposal ?? null, proposals: proposals.slice(0, 3), corrections, blockers: []
  };
}
