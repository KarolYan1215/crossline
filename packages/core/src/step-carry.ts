import type { FrozenBlock } from "./schedule-frozen";

/**
 * What a replan carries over from the steps it replaces (docs/plans/near-term-and-mail-bar-1120.md R2, 2026-11-20): a block the person
 * locked or started and the progress they reported stay with the work, not with the old step id the new plan no longer has. Done and
 * skipped steps are kept by the store itself (`saveStepPlan`); this is for the open ones it replaces.
 *
 * Each replaced open step goes to the new step with the same or a containing title; one that matches none goes to the task itself, which
 * for a planned task is its first person's step (the planner places a task with a plan only by its steps). Steps that kept their id map
 * to themselves and are left out.
 */
export function carryOverSteps(old: ReadonlyArray<{ id: string; title: string }>, next: ReadonlyArray<{ id: string; title: string; executor: string }>): Map<string, string> {
  const ids = new Set(next.map((step) => step.id));
  const plain = (title: string) => title.replace(/\s+/g, "").toLowerCase();
  const own = next.filter((step) => step.executor !== "agent");
  const fallback = (own[0] ?? next[0])?.id;
  const out = new Map<string, string>();
  for (const step of old) {
    if (ids.has(step.id)) continue;
    const title = plain(step.title);
    const same = next.find((item) => plain(item.title) === title)
      ?? next.find((item) => title.length >= 2 && (plain(item.title).includes(title) || title.includes(plain(item.title))));
    const target = same?.id ?? fallback;
    if (target) out.set(step.id, target);
  }
  return out;
}

/**
 * The frozen blocks of one task with their step ids moved by `rename` (`scheduled:<order>:<old>[:n]` → `scheduled:<order>:<new>:n`).
 * Two old steps landing on one new step keep distinct ids (`:2`, `:3`), as segments of one step do; everything else is untouched.
 */
export function remapFrozenSteps(list: readonly FrozenBlock[], orderId: string, rename: ReadonlyMap<string, string>): FrozenBlock[] {
  const taken = new Set(list.map((item) => item.blockId));
  return list.map((item) => {
    const [kind, order, step] = item.blockId.split(":");
    const target = kind === "scheduled" && order === orderId && step ? rename.get(step) : undefined;
    if (!target) return item;
    taken.delete(item.blockId);
    let index = 1;
    const idOf = (n: number) => `scheduled:${orderId}:${target}${n > 1 ? `:${n}` : ""}`;
    while (taken.has(idOf(index))) index += 1;
    taken.add(idOf(index));
    return { ...item, blockId: idOf(index) };
  });
}
