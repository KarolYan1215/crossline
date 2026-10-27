import "server-only";
import { listAgentTasks } from "@crossline/db";
import type { AccessContext } from "@crossline/core";
import { getStore } from "./crossline";

/** Errands the input box set going (`createErrand` in `lib/life.ts`): what the assistant prepared for each, kept apart from the bell. */
const TOOLING = /\.(ps1|py|js|mjs|ts|sh|bat|cmd|json)$/i;
const squash = (text: string) => text.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();

/** The assistant's finished files for an errand (accepted, or awaiting review), helper scripts left out. */
export function errandFiles(ctx: AccessContext, orderId: string): Array<{ href: string; name: string }> {
  return listAgentTasks(getStore(), ctx.workspaceId).filter((task) => task.workOrderId === orderId && (task.status === "accepted" || task.status === "needs_review"))
    .flatMap((task) => task.artifacts.filter((artifact) => !TOOLING.test(artifact.path)).map((artifact) => ({
      href: `/api/agent/tasks/${encodeURIComponent(task.taskId)}/file?path=${encodeURIComponent(artifact.path)}`, name: artifact.path.split(/[\\/]/).at(-1) ?? artifact.path })));
}

type Errand = { orderId: string; title: string; date: string; start: string };
export const errands =(ctx: AccessContext): Errand[] => getStore().listWorkOrders(ctx.workspaceId).flatMap((order) => {
  const errand = (order.payload as { errand?: { title?: string; date?: string; start?: string } } | undefined)?.errand;
  return errand && order.state !== "archived" ? [{ orderId: order.id, title: errand.title ?? "", date: errand.date ?? "", start: errand.start ?? "" }] : [];
});

/** For the day view: the prepared files of the errand an event block stands for (same day, same start or same name). */
export function preparedForEvents(ctx: AccessContext): (item: { day: string; start: string; title: string }) => Array<{ href: string; name: string }> {
  const list = errands(ctx);
  if (!list.length) return () => [];
  return (item) => {
    const errand = list.find((entry) => entry.date === item.day && (entry.start === item.start || squash(entry.title) === squash(item.title)));
    return errand ? errandFiles(ctx, errand.orderId) : [];
  };
}
