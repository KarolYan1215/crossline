import { documentsByRef, locateQuote } from "@crossline/core";
import type { CrosslineStore, StoredSentence } from "./index";

/** Recorded once a workspace's older facts have been given their sentences, so the pass runs once. */
export const EVIDENCE_BACKFILL_SETTING = "evidence.backfill.v1";

/**
 * Gives every fact written before numbered evidence (2026-10-19) the sentences its quote stands in: the reply or file its `sourceRef`
 * names is cut into numbered sentences the same way a new one is, the quote is found by its letters and digits, and the sentences it
 * covers are recorded. A `reply-N` names a message only within its conversation, so every conversation's N-th message is tried and the
 * first whose text holds the quote wins. A quote found nowhere (a file since removed, a reply reworded) is left as it is and counted.
 */
export function backfillFactEvidence(store: CrosslineStore, workspaceId: string): { linked: number; unlinked: number } | undefined {
  if (store.getSetting(workspaceId, EVIDENCE_BACKFILL_SETTING)) return undefined;
  const docs = documentsByRef(store.listSourceDocuments(workspaceId));
  const sessions = store.listOnboardingSessions(workspaceId);
  const messages = sessions.flatMap((session) => store.listOnboardingMessages(workspaceId, session.id)
    .filter((message) => message.role === "user").map((message) => ({ session: session.id, message })));
  let linked = 0, unlinked = 0;
  for (const fact of store.listProfileFacts(workspaceId)) {
    if (fact.sourceSentences?.length || !fact.sourceQuote.trim() || !/^(reply|src)-\d+$/.test(fact.sourceRef)) continue;
    const candidates: Array<{ text: string; sentences: () => StoredSentence[] }> = fact.sourceRef.startsWith("src-")
      ? (() => { const doc = docs.get(fact.sourceRef); return doc && doc.extractionStatus === "done"
        ? [{ text: doc.extractedText, sentences: () => store.ensureEvidence(workspaceId, "document", doc.id, doc.extractedText) }] : []; })()
      : messages.filter(({ message }) => `reply-${message.seq}` === fact.sourceRef).map(({ session, message }) => {
        const text = String((message.content as { text?: string }).text ?? "");
        return { text, sentences: () => store.ensureEvidence(workspaceId, "reply", `${session}#${message.seq}`, text) };
      });
    const hit = candidates.map((candidate) => ({ candidate, span: locateQuote(candidate.text, fact.sourceQuote) })).find((item) => item.span);
    if (!hit?.span) { unlinked += 1; continue; }
    const ids = hit.candidate.sentences().filter((sentence) => sentence.start < hit.span!.end && sentence.end > hit.span!.start).map((sentence) => sentence.id);
    if (!ids.length) { unlinked += 1; continue; }
    store.setProfileFactSentences(workspaceId, fact, ids);
    linked += 1;
  }
  store.setSetting(workspaceId, EVIDENCE_BACKFILL_SETTING, JSON.stringify({ at: new Date().toISOString(), linked, unlinked }));
  return { linked, unlinked };
}
