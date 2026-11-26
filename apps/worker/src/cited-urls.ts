import { urlKnown, urlsIn } from "@crossline/core";

/**
 * The addresses at which code may open a page a run cited (docs/plans/harness-1125.md §10): what the run's web research returned
 * (`audit.webUrls`) and what its input gave (the person's own). A cited address outside them was composed by the model — possibly
 * around private data in a query string — and is not opened: opening it would send that data to whoever runs the host.
 */
export function citableUrls(audit: { webUrls?: string[] | undefined }, ...given: unknown[]): string[] {
  return [...(audit.webUrls ?? []), ...given.flatMap((value) => urlsIn(typeof value === "string" ? value : JSON.stringify(value) ?? ""))];
}
/** Whether a cited address may be opened; `known` unset means the run had the hosted search (no private context) and anything may. */
export const citable = (url: string, known: readonly string[] | undefined): boolean => !known || urlKnown(url, known);
