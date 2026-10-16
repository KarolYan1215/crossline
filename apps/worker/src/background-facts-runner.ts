import {
  BACKGROUND_FACTS_OUTPUT_SCHEMA, validateBackgroundFactsProposal,
  type BackgroundFactsContext, type BackgroundFactsProposal
} from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { identityLines } from "./lines";
import { tOfWorkspace } from "./locale";

export const BACKGROUND_FACTS_SKILL = "crossline:crossline-background-facts";

// i18n-ignore-start: model-facing
const INSTRUCTIONS = "You are silently compacting one capture into structured background facts about "
  + "the user's own identities/主线 — current experiment or paper title, key file or repo paths, the "
  + "client or project name, anything durable that later tasks in the same identity would benefit from "
  + "already knowing. This is not classification (you are not choosing which identity the capture itself "
  + "belongs to, only which identity a fact you extract is ABOUT) and it is not a conversation — return "
  + "only new or changed facts, or an empty list when the capture has nothing durable in it, which is the "
  + "normal case for most captures. Every fact needs a short stable `key` (snake_case, reusable across "
  + "captures so a later update overwrites the same fact instead of duplicating it), a `value`, a `why` "
  + "explaining its relevance, and `sourceQuote` — the exact substring of the capture's title or context "
  + "that supports it; never paraphrase into the quote. If nothing in the capture is durable background "
  + "(most short task notes), return an empty facts array — that is success, not a blocker. Only use a "
  + "blocker for something that actually prevents processing, not for \"nothing to extract\".";
// i18n-ignore-end

export type BackgroundFactsOutcome =
  | { state: "extracted"; factCount: number }
  | { state: "blocked"; code: string; message: string };

export function buildBackgroundFactsContext(store: CrosslineStore, workspaceId: string,
  captureTitle: string, captureContext: string): BackgroundFactsContext {
  const identities = identityLines(store, workspaceId)
    .map((pack) => ({ id: pack.id, label: pack.label }));
  const existingFacts = identities.flatMap((identity) => store.getBackgroundFacts(workspaceId, identity.id)
    .map((fact) => ({ identityId: identity.id, key: fact.key, value: fact.value, updatedAt: fact.updatedAt })));
  return { version: "crossline.background-facts.v1", identities, existingFacts, captureTitle, captureContext };
}

/**
 * Runs the background-facts compaction Skill against one capture's own text and merges whatever it
 * finds into each named identity's fact bucket. Called fire-and-forget right after a capture is
 * written (`POST /api/commands`'s `task.capture` branch) — a failure here must never surface as a
 * capture failure, which is why the caller never awaits this in a way that affects its own response.
 */
export function createBackgroundFactsExtractor(store: CrosslineStore, workspaceId: string, cwd: string,
  getClient: () => CodexRpcBoundary | undefined) {
  return async function extract(captureTitle: string, captureContext: string, signal?: AbortSignal): Promise<BackgroundFactsOutcome> {
    const t = tOfWorkspace(store, workspaceId);
    const client = getClient();
    if (!client) return { state: "blocked", code: "CODEX_SUPERVISOR_UNAVAILABLE", message: t("Codex 运行时不可用。") };
    if (!captureTitle.trim() && !captureContext.trim()) {
      return { state: "blocked", code: "BACKGROUND_FACTS_NO_INPUT", message: t("捕获内容为空。") };
    }
    const context = buildBackgroundFactsContext(store, workspaceId, captureTitle, captureContext);

    const result = await runCodexSkill<BackgroundFactsProposal>(client, context, {
      skillName: BACKGROUND_FACTS_SKILL,
      cwd,
      developerInstructions: INSTRUCTIONS,
      outputSchema: BACKGROUND_FACTS_OUTPUT_SCHEMA,
      prepareInput: () => context,
      validateOutput: (output) => validateBackgroundFactsProposal(output, context),
      onAudit: () => {},
      ...(signal ? { signal } : {}),
      timeoutMs: 60 * 60_000
    });
    if (!result.ok) return { state: "blocked", code: result.blocker.code, message: result.blocker.message };

    const byIdentity = new Map<string, Array<{ key: string; value: string; why: string; sourceQuote: string }>>();
    for (const fact of result.output.facts) {
      const list = byIdentity.get(fact.identityId) ?? [];
      list.push({ key: fact.key, value: fact.value, why: fact.why, sourceQuote: fact.sourceQuote });
      byIdentity.set(fact.identityId, list);
    }
    for (const [identityId, facts] of byIdentity) store.mergeBackgroundFacts(workspaceId, identityId, facts);
    return { state: "extracted", factCount: result.output.facts.length };
  };
}
