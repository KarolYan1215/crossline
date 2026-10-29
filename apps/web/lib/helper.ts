import "server-only";
import type { AccessContext } from "@crossline/core";
import { listAgentTasks } from "@crossline/db";
import { getStore } from "./crossline";
import { currentFigure, figureUrl } from "./figures";
import { runtimeStatus } from "./runtime-status";
import { personCalls, type PersonCall } from "./person-calls";
import { loadTimeline } from "./timeline";
import { nextBlock } from "../app/timeline/panel-model";
import { minuteInZone } from "../app/timeline/model";

/** One stretch of today on the 小帮手's time band: work the plan placed, or a fixed arrangement (a calendar event, a file's class). */
export type HelperBandBlock = { start: string; end: string; kind: "work" | "fixed"; title: string; line?: string; missed?: boolean };
/**
 * What the narrow 小帮手 window shows above the conversation (docs/plans/page-drafts-1028/helper.html): today's blocks as one band, the
 * next block of work, and the assistant's runs going on now (each with its progress and 停止 — their one home, scenarios.md §3 conclusion 11).
 */
export type HelperDay = { day: string; timeZone: string; nowIso: string; blocks: HelperBandBlock[];
  next?: { start: string; title: string; step?: string; workOrderId: string };
  running: Array<{ taskId: string; title: string; startedAt: string }> };

export async function helperDay(ctx: AccessContext): Promise<HelperDay> {
  const timeline = await loadTimeline(ctx);
  const blocks = timeline.items.filter((item) => item.day === timeline.today && ["scheduled", "calendar", "import"].includes(item.kind))
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((item): HelperBandBlock => ({ start: item.start, end: item.end, kind: item.kind === "scheduled" ? "work" : "fixed", title: item.task ?? item.title,
      ...(item.identityId ? { line: item.identityId } : {}), ...(item.missed ? { missed: true } : {}) }));
  const next = nextBlock(timeline.items, timeline.today, timeline.today, minuteInZone(timeline.nowIso, timeline.timeZone));
  return { day: timeline.today, timeZone: timeline.timeZone, nowIso: timeline.nowIso, blocks,
    ...(next?.workOrderId ? { next: { start: next.start, title: next.task ?? next.title, workOrderId: next.workOrderId, ...(next.step ? { step: next.step } : {}) } } : {}),
    running: listAgentTasks(getStore(), ctx.workspaceId).filter((task) => task.status === "running")
      .map((task) => ({ taskId: task.taskId, title: task.title, startedAt: task.requestedAt })) };
}

/**
 * What the floating 小帮手 shows: the person's portrait figure (null until one is drawn), what the background is doing, and what only the
 * person can do now (`calls`, said on every page).
 */
export type HelperState = { avatar: string | null; working: boolean; down: boolean; calls: PersonCall[] };

/**
 * The figure is the person's (`currentFigure`: the one they picked on the portrait page, else the latest drawing, whatever report version
 * drew it), addressed by file and time so a new one is fetched once and the old one stays cached. A guest runtime that cannot draw
 * images, or a report not written yet, has none, and the page keeps the text button.
 */
export async function helperState(ctx: AccessContext): Promise<HelperState> {
  const store = getStore();
  const figure = currentFigure(ctx);
  const status = await runtimeStatus(ctx);
  return {
    avatar: figure ? figureUrl(figure) : null,
    working: listAgentTasks(store, ctx.workspaceId).some((task) => task.status === "running"),
    // The developer's model standing in for a spent ChatGPT is a notice, not the worker being down.
    down: Boolean(status) && status?.code !== "sponsor_standin",
    calls: personCalls(ctx)
  };
}
