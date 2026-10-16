import { CodexSupervisorRequestError, requestCodexSupervisor } from "../../../../lib/codex-runtime";
import { tOf } from "../../../../lib/locale";
import { validId, writeGuard } from "../guard";

/**
 * 交给助手: hands one work order to the assistant now. The worker answers as soon as the task is under way (or says why it is not);
 * the result arrives in the ledger when the task is done, and is looked at on the Assistant page.
 */
export async function POST(request: Request) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { workOrderId, category, stepId } = guard.body;
  if (typeof workOrderId !== "string" || !validId(workOrderId)) return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  try {
    const result = await requestCodexSupervisor<unknown>(guard.ctx, "/v1/agent/dispatch", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workOrderId, ...(typeof category === "string" ? { category } : {}), ...(typeof stepId === "string" && validId(stepId) ? { stepId } : {}) }), signal: AbortSignal.timeout(15_000)
    });
    return Response.json({ ok: true, ...(result as object) });
  } catch (error) {
    if (error instanceof CodexSupervisorRequestError) return Response.json({ ok: false, blocker: error.blocker }, { status: error.status });
    return Response.json({ ok: false, blocker: { code: "AGENT_DISPATCH_FAILED", message: tOf(guard.ctx)("没能交给助手。") } }, { status: 503 });
  }
}
