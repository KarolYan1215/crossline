import {
  ASSISTANT_OUTPUT_SCHEMA, validateAssistantTurnProposal,
  type AssistantTurnContext, type AssistantTurnProposal
} from "@crossline/core";
import { runCodexSkill, continueSkillTurn, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { persistAssistantMaterial } from "./materials";

const OWNER_ID = "local-owner";
export const ASSISTANT_SKILL = "crossline:crossline-assistant";

const INSTRUCTIONS = "You are the site-wide Crossline assistant — a general-purpose conversational "
  + "helper available on every page, separate from the homepage's own quick-capture box (which only "
  + "ever collects a task; you handle everything else: follow-up questions, explaining what something "
  + "means, and generating small code snippets or scripts). Offer `quickReplies` (short button labels) "
  + "when a multiple-choice follow-up would genuinely help; leave it empty for a plain answer. You may "
  + "fill `materialDraft` with a small script or text file ONLY when this conversation is scoped to a "
  + "specific task (you will be told so) and the person's request clearly calls for a saved artifact, "
  + "not just an inline code block in your reply — most turns should leave it null. Never claim to have "
  + "read or modified this application's own source code, and never suggest you can — you cannot; "
  + "everything you produce is either conversation text or one file offered as a task material. If a "
  + "request is unsafe or outside what you can actually do, return a blocker explaining why rather than "
  + "pretending to comply.";

export type AssistantTurnOutcome =
  | { state: "replied"; reply: string; quickReplies: string[]; savedMaterial?: { uri: string; fileName: string } }
  | { state: "blocked"; code: string; message: string };

export function buildAssistantContext(history: Array<{ from: "user" | "assistant"; text: string }>,
  message: string, attachments: Array<{ id: string; fileName: string; mediaType: string }>,
  workOrderId: string | null): AssistantTurnContext {
  return { version: "crossline.assistant.v1", history, message, attachments, workOrderId };
}

/**
 * One entry point for every turn, first or follow-up — the caller always supplies the same client-
 * generated `threadId` for a conversation (unlike onboarding's two-route open/continue split, this
 * widget lets a person attach a file before ever sending a message, so a stable id has to exist from
 * the start rather than only appearing after the first Codex reply). Whether this actually opens a new
 * Codex thread or continues one already open is decided here, from whether `assistant_threads` already
 * has a `codexThreadId` for this `threadId`.
 */
export function createAssistantTurn(store: CrosslineStore, workspaceId: string, cwd: string,
  getClient: () => CodexRpcBoundary | undefined) {
  return async function turn(threadId: string, message: string,
    history: Array<{ from: "user" | "assistant"; text: string }>,
    attachments: Array<{ id: string; fileName: string; mediaType: string }>,
    workOrderId: string | null, signal?: AbortSignal): Promise<AssistantTurnOutcome> {
    const client = getClient();
    if (!client) return { state: "blocked", code: "CODEX_SUPERVISOR_UNAVAILABLE", message: "Codex 运行时不可用。" };
    if (!message.trim()) return { state: "blocked", code: "ASSISTANT_MESSAGE_REQUIRED", message: "消息不能为空。" };

    const existing = store.getAssistantThread(workspaceId, threadId);
    const context = buildAssistantContext(history, message, attachments, workOrderId ?? existing?.workOrderId ?? null);
    let codexThreadId = existing?.codexThreadId;

    const result = codexThreadId
      ? await continueSkillTurn<AssistantTurnProposal>(client, codexThreadId, message.slice(0, 4000), {
          skillName: ASSISTANT_SKILL, cwd, outputSchema: ASSISTANT_OUTPUT_SCHEMA,
          validateOutput: (output) => validateAssistantTurnProposal(output, context), onAudit: () => {},
          ...(signal ? { signal } : {}), timeoutMs: 10 * 60_000
        })
      : await runCodexSkill<AssistantTurnProposal>(client, context, {
          skillName: ASSISTANT_SKILL, cwd, developerInstructions: INSTRUCTIONS,
          outputSchema: ASSISTANT_OUTPUT_SCHEMA, prepareInput: () => context,
          validateOutput: (output) => validateAssistantTurnProposal(output, context),
          onAudit: (audit) => { codexThreadId = audit.threadId; },
          ...(signal ? { signal } : {}), timeoutMs: 10 * 60_000
        });

    const now = new Date().toISOString();
    store.saveAssistantThread({
      id: threadId, ownerId: OWNER_ID, workspaceId,
      ...(codexThreadId ? { codexThreadId } : {}),
      ...(context.workOrderId ? { workOrderId: context.workOrderId } : {}),
      createdAt: existing?.createdAt ?? now, updatedAt: now
    });
    if (!result.ok) return { state: "blocked", code: result.blocker.code, message: result.blocker.message };

    let savedMaterial: { uri: string; fileName: string } | undefined;
    if (result.output.materialDraft && context.workOrderId) {
      const draft = result.output.materialDraft;
      const persisted = persistAssistantMaterial(store, {
        workspaceId, ownerId: OWNER_ID, workOrderId: context.workOrderId, projectRoot: cwd,
        file: { relativePath: draft.relativePath, content: draft.content, mediaType: draft.mediaType, sourceRefs: draft.sourceRefs }
      });
      if (persisted.ok) savedMaterial = { uri: persisted.artifact.uri, fileName: draft.relativePath };
    }
    return {
      state: "replied", reply: result.output.reply, quickReplies: result.output.quickReplies,
      ...(savedMaterial ? { savedMaterial } : {})
    };
  };
}
