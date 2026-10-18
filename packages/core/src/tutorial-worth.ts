import { infoRequestTraits } from "./info-request";

/**
 * Whether a task is worth a tutorial (walkthrough W-17, 2026-10-17: the 17-minute 「把门店名单发给陈默」 got one, and a tutorial costs about
 * 240k tokens). A tutorial is for work whose own steps need learning or method; none is written when
 * - the task is a request for a fact or a send (`infoRequestTraits`): a message and a reply, nothing to study; or
 * - the person's own work adds up to less than `TUTORIAL_MIN_MINUTES` (their steps' usual minutes; with no plan yet, the task's).
 */
export const TUTORIAL_MIN_MINUTES = 45;

type Step = { executor: string; schedulable: boolean; status: string; estimate: { p50Minutes: number } };

export function tutorialWorthIt(task: { title: string; intent: string; p50Minutes: number }, steps?: readonly Step[]): boolean {
  if (infoRequestTraits({ title: task.title, intent: task.intent, p50Minutes: task.p50Minutes }).match) return false;
  const own = steps?.filter((step) => step.executor !== "agent" && step.schedulable);
  const minutes = own?.length ? own.reduce((sum, step) => sum + step.estimate.p50Minutes, 0) : task.p50Minutes;
  return minutes >= TUTORIAL_MIN_MINUTES;
}
