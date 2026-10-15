import { notFound } from "next/navigation";
import { SubpageShell } from "../../subpage-shell";
import { requireSessionContext } from "../../../lib/access-guard";
import { gateUntilReady } from "../../../lib/start-gate";
import { getStore } from "../../../lib/crossline";
import { TutorialStandalone } from "./tutorial-standalone";

export const dynamic = "force-dynamic";

/** A task's tutorial as a page of its own: the table of contents beside the text, each section linking back to its step on the task. */
export default async function TutorialPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireSessionContext();
  gateUntilReady(ctx);
  const { id } = await params;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) notFound();
  const order = getStore().getWorkOrder(ctx.workspaceId, id);
  if (!order) notFound();
  return <SubpageShell active="任务" title={`教程：${order.intent}`}>
    <p className="material-back"><a href={`/workbench/${encodeURIComponent(id)}`}>← 回到任务</a></p>
    <TutorialStandalone workOrderId={id} building={order.state === "preparing"} />
  </SubpageShell>;
}
