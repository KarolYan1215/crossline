/**
 * What the worker answered to 「交给助手」. The route answers 200 whenever the worker answered, with `state` saying whether a run started; a
 * step's button read only the HTTP status and said 「已交给助手」 for a refusal too (W-151: 「这件事的描述没有明确指向某一类工作」 and
 * 「该步骤需要本人完成」 both showed as handed over, and nothing ran).
 */
export type HandoffAnswer = { ok?: boolean; state?: string; message?: string; blocker?: { message?: string } } | null;
export type HandoffOutcome = { kind: "started" } | { kind: "needs_category" } | { kind: "refused"; message: string };

export function handoffOutcome(body: HandoffAnswer): HandoffOutcome {
  if (body?.state === "started") return { kind: "started" };
  if (body?.state === "needs_category_approval") return { kind: "needs_category" };
  return { kind: "refused", message: body?.message ?? body?.blocker?.message ?? "" };
}

/** Hands the order (or one of its steps) to the assistant and reads the answer. */
export async function handOff(workOrderId: string, stepId?: string): Promise<HandoffOutcome> {
  try {
    const response = await fetch("/api/agent/dispatch", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workOrderId, ...(stepId ? { stepId } : {}) }) });
    return handoffOutcome(await response.json().catch(() => null) as HandoffAnswer);
  } catch { return { kind: "refused", message: "" }; }
}
