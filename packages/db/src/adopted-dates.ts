import type { DateCandidate } from "@crossline/core";
import type { CrosslineStore } from "./index";

/**
 * The dated items the person adopted, as the model read them (2026-11-22): a confirmed `date_<yyyymmdd>_<kind>` fact holds only the day
 * and the title, so what else the reading said — which piece of work a date belongs to (`work`), whether it ends the project's weekly
 * arrangements (`endsSeries`) — is read back from the batch the fact was written from. An item counts while its fact is on record
 * (adopted and not taken back); the newest reading of the same day and title wins.
 */
export function adoptedDateItems(store: CrosslineStore, workspaceId: string): DateCandidate[] {
  const facts = new Set(store.listProfileFacts(workspaceId).filter((fact) => fact.status === "confirmed" && fact.slot.startsWith("date_"))
    .map((fact) => `${fact.slot}|${fact.value}`));
  const out = new Map<string, DateCandidate>();
  for (const event of store.listEvents(workspaceId, { type: "dates.extracted" })) {
    for (const item of (event.payload as { dates?: DateCandidate[] }).dates ?? []) {
      const key = `date_${item.date.replaceAll("-", "")}_${item.kind}|${item.date} ${item.title}`;
      if (facts.has(key)) out.set(`${key}|${item.project}`, item);
    }
  }
  return [...out.values()];
}
