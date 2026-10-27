import {
  BACKGROUND_FACTS_OUTPUT_SCHEMA, validateBackgroundFactsProposal,
  type BackgroundFactsContext, type BackgroundFactsProposal
} from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { identityLines } from "./lines";
import { tOfWorkspace } from "./locale";

export const BACKGROUND_FACTS_SKILL = "crossline:crossline-background-facts";

// The scenario in brief; the Skill has the rules and the examples (this used to be a second copy of it).
// i18n-ignore-start: model-facing
const INSTRUCTIONS = "You run silently after the person captured one line, as the Skill describes: keep only durable background a later task "
  + "on the same line would want already (a paper's title, a key path, a client's name), shown under 「相关背景」 on those tasks. Most "
  + "captures have none: an empty facts array is success, not a blocker. Reuse an existing key to update it; `sourceQuote` is an exact "
  + "substring of the capture. Return raw JSON only.";
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
