import { pathIsContained, TEXT_MEDIA_TYPES, PREFIX_THE_APP_OWNS, TOTAL_CONTENT_LIMIT } from "./materials-schema";

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
};

export type AssistantTurnProposal = {
  reply: string;
  /** Codex-style quick-reply suggestions shown as buttons under the reply; empty is normal for a turn
   * that is just answering something, not asking a follow-up. */
  quickReplies: string[];
  materialDraft: { relativePath: string; content: string; mediaType: string; sourceRefs: string[] } | null;
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
  blockers: { type: "array", maxItems: 5, items: object({ code: shortStr, message: shortStr }) }
});

export function validateAssistantTurnProposal(value: unknown, context: AssistantTurnContext): AssistantTurnProposal {
  const raw = value as AssistantTurnProposal | undefined;
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
  return { reply: raw.reply, quickReplies: raw.quickReplies, materialDraft: raw.materialDraft ?? null, blockers: [] };
}
