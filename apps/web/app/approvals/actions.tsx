"use server";

import { requireSessionContext } from "../../lib/access-guard";
import { LaterApprovals } from "./later";
import { AssistantResultBody } from "./assistant-review";

/**
 * The parts of 待确认 read after the page is shown (2026-10-28, `LazyRegion`): each answers for the signed-in person's own workspace,
 * whatever it is handed — the session is read again here, never taken from the page.
 */
export async function laterApprovals() {
  const ctx = await requireSessionContext();
  return <LaterApprovals ctx={ctx} />;
}

/** One assistant result's body (its files with previews, checks, what was left and assumed, the run record). */
export async function assistantResult(taskId: string) {
  const ctx = await requireSessionContext();
  return <AssistantResultBody ctx={ctx} taskId={String(taskId)} />;
}
