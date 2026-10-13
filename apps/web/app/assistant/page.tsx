import { redirect } from "next/navigation";
import { requireSessionContext } from "../../lib/access-guard";
import { gateUntilReady } from "../../lib/start-gate";
import { countAssistantPending } from "../../lib/agent";

export const dynamic = "force-dynamic";

/**
 * The assistant no longer has a page of its own (decided 2026-10-07): what waits for a decision is on 待确认, the capabilities and the
 * recent tasks are in 设置 → 自动化与助手. Old links land on whichever of the two has something to show.
 */
export default async function AssistantPage() {
  const ctx = await requireSessionContext();
  gateUntilReady(ctx);
  const pending = countAssistantPending(ctx);
  redirect(pending.categories + pending.approvals + pending.reviews ? "/approvals#assistant" : "/settings#automation");
}
