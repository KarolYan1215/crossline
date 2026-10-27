/**
 * The proposal waiting for the person whose due day is nearest, when it falls within `days` (walkthrough W-31, 2026-10-17: the base line's
 * task due 10/24 waited for approval while 「下一步」 recommended a 5%-share investor task and gave it Monday 9:00). Unapproved work is
 * not scheduled — by design — so Today says which decision stands between that deadline and the calendar. Overdue counts too.
 */
export type ProposalDue = { id: string; title: string; due?: string | undefined };

export function nearestDueProposal(items: readonly ProposalDue[], today: string, days = 7): (ProposalDue & { due: string }) | undefined {
  const limit = new Date(Date.parse(`${today}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  return items.filter((item): item is ProposalDue & { due: string } => Boolean(item.due && /^\d{4}-\d{2}-\d{2}$/.test(item.due) && item.due <= limit))
    .sort((a, b) => a.due.localeCompare(b.due))[0];
}
