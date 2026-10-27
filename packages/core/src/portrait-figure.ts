/**
 * The person's cartoon figure is theirs, not the report's (2026-10-21, after a schema rewrite replaced the figure the owner had chosen
 * with a different-looking one). A drawn figure stays until the person describes how they look differently or asks for a new one; a
 * report rewritten for a new schema, or 重新生成 of the words, keeps it. The person can also pick any figure drawn before, or one of their
 * own, as the one the 小帮手 and the portrait show (`PORTRAIT_FIGURE_SETTING`).
 */

/** The figure the person picked (`{file, at}`), over the latest drawing. Undoable; never written by the system. */
export const PORTRAIT_FIGURE_SETTING = "portrait.figure";

/**
 * Figure files in a workspace's portrait folder: `v<report version>-character.png` drawn (`v<version>r<n>-…` for a later drawing of the
 * same version, so no drawing is ever written over), `u<n>-character.png` one the person added.
 */
export const FIGURE_FILE = /^(?:v\d+(?:r\d+)?|u\d+)-character\.png$/;

/** Person facts that say how the person looks (the same slots the appearance question looks for). */
export const APPEARANCE_FACT_SLOT = /^(appearance|appearance_skipped|gender|hairstyle|clothing_preference)$/;

type Fact = { identityId: string; slot: string; value: string; status: string; updatedAt: string };

/** What the person has said about how they look, in their own confirmed facts, as one comparable string ("" when nothing). */
export function appearanceBasis(facts: readonly Fact[]): string {
  return facts.filter((fact) => fact.identityId === "person" && fact.status === "confirmed" && APPEARANCE_FACT_SLOT.test(fact.slot))
    .map((fact) => `${fact.slot}=${fact.value.trim()}`).sort().join("\n");
}

/** When the person last changed what they said about how they look; null when they never did. */
export function appearanceChangedAt(facts: readonly Fact[]): string | null {
  const times = facts.filter((fact) => fact.identityId === "person" && fact.status === "confirmed" && APPEARANCE_FACT_SLOT.test(fact.slot))
    .map((fact) => fact.updatedAt).sort();
  return times.at(-1) ?? null;
}

/**
 * Whether a new figure is drawn. Always when the person asked (`redraw`) or none exists. Otherwise only when what the person said about how
 * they look is not what the current figure was drawn from: compared by `basis` when the drawing recorded one, and for a drawing from
 * before that was recorded, by whether an appearance fact changed after it was drawn.
 */
export function figureRedrawDue(current: { file?: string; at?: string; basis?: string } | undefined, facts: readonly Fact[], redraw = false): boolean {
  if (redraw || !current?.file) return true;
  if (current.basis !== undefined) return current.basis !== appearanceBasis(facts);
  const changed = appearanceChangedAt(facts);
  return Boolean(changed && current.at && changed > current.at);
}

/** A figure file's kind and number (the report version it was drawn for, or the n-th upload); null for anything else. */
export function figureVersionOf(file: string): { kind: "drawn" | "uploaded"; number: number; redraw: number } | null {
  if (!FIGURE_FILE.test(file)) return null;
  const match = /^([vu])(\d+)(?:r(\d+))?-/.exec(file)!;
  return { kind: match[1] === "v" ? "drawn" : "uploaded", number: Number(match[2]), redraw: Number(match[3] ?? 1) };
}

/** Where a new drawing for this report version goes: the version's own name while free, else the next `r<n>` (nothing is overwritten). */
export function nextDrawnFigureFile(version: number, existing: readonly string[]): string {
  const taken = new Set(existing);
  if (!taken.has(`v${version}-character.png`)) return `v${version}-character.png`;
  let n = 2;
  while (taken.has(`v${version}r${n}-character.png`)) n += 1;
  return `v${version}r${n}-character.png`;
}

/** Where a figure the person adds goes. */
export function nextUploadedFigureFile(existing: readonly string[]): string {
  const numbers = existing.map(figureVersionOf).flatMap((item) => item?.kind === "uploaded" ? [item.number] : []);
  return `u${Math.max(0, ...numbers) + 1}-character.png`;
}
