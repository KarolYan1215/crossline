import { RUNTIME_OWNER_SETTING } from "@crossline/core";
import { applicationProfile, assistantAvailable, nodeComputeOn, profileUsage, readFormRuns, readKit } from "@crossline/db";
import type { ApplyKit } from "@crossline/core";
import type { ApplyItem, ApplyRun } from "../app/settings/apply-card";
import { getStore } from "./crossline";

/**
 * The settings page's 报名资料卡 (docs/opportunity-agent.md §12): the profile as the form filler reads it — a sensitive item only as
 * held — and every registration run, shortened to what the card shows. Undefined for any workspace but the machine owner's and an
 * account that paired its own computer as a compute node (its forms are filled in that computer's browser, docs/compute-node.md).
 */
export function loadApplyCard(workspaceId: string): { items: ApplyItem[]; runs: ApplyRun[]; screen: boolean; kit: ApplyKit } | undefined {
  const store = getStore();
  const owner = store.getSetting(workspaceId, RUNTIME_OWNER_SETTING) === "1" || assistantAvailable(store, workspaceId) || nodeComputeOn(store, workspaceId);
  if (!owner) return undefined;
  const usage = profileUsage(store, workspaceId);
  const items: ApplyItem[] = applicationProfile(store, workspaceId).map((item) => ({ slot: item.slot, sensitive: item.sensitive, present: item.present,
    ...(item.sensitive || item.value === undefined ? {} : { value: item.value }), usedBy: (usage[item.slot] ?? []).map((use) => ({ title: use.title, at: use.at })) }));
  const runs: ApplyRun[] = readFormRuns(store, workspaceId).slice(0, 30).map((run) => ({
    id: run.id, title: run.opportunity.title, host: run.host, state: run.state, pageNo: run.pageNo,
    ...(run.stoppedFor ? { stoppedFor: run.stoppedFor } : {}), ...(run.stopDetail ? { stopDetail: run.stopDetail } : {}), ...(run.missingSlot ? { missingSlot: run.missingSlot } : {}),
    heldBecause: run.heldBecause ?? [], checklist: (run.checklist ?? []).map((item) => ({ field: item.field, shown: item.shown })),
    problems: (run.check?.problems ?? []).map((item) => item.field ? `${item.field}: ${item.problem}` : item.problem),
    injections: run.pages.reduce((sum, page) => sum + page.injections.length, 0),
    refused: run.pages.reduce((sum, page) => sum + page.actions.filter((action) => action.verdict === "refuse").length, 0),
    shots: run.screenshots.length, ...(run.confirmation?.quote ? { confirmation: run.confirmation.quote } : {}), ...(run.submittedBy ? { submittedBy: run.submittedBy } : {}),
    calendar: Boolean(run.calendarEventId), updatedAt: run.updatedAt
  }));
  // The web cannot see the worker's screen; the worker refuses a queue without one, which the card says when it happens.
  return { items, runs, screen: process.env.CROSSLINE_PUBLIC_BETA !== "1", kit: readKit(store, workspaceId) };
}
