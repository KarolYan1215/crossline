import { NextResponse } from "next/server";
import { requestCodexSupervisor, CodexSupervisorRequestError } from "../../../../lib/codex-runtime";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/**
 * The one-click "read my Codex history" step ahead of the onboarding conversation
 * (`codex-history-consent.tsx`). A plain local filesystem read on the worker's machine, gated the same way
 * every other Codex supervisor call is — same-origin, capability-token-signed — even though it spends no
 * Codex quota itself; the person still only gets this by clicking the button, every time, never a
 * standing setting.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, blocker: { code: "REQUEST_FORBIDDEN", message: "Use the local Web API" } }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  try {
    const result = await requestCodexSupervisor<unknown>(access.ctx, "/v1/onboarding/codex-history/scan", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      signal: AbortSignal.timeout(30_000)
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof CodexSupervisorRequestError) {
      return NextResponse.json({ ok: false, blocker: error.blocker }, { status: error.status });
    }
    return NextResponse.json({ ok: false, blocker: { code: "CODEX_HISTORY_SCAN_FAILED", message: "无法读取本地 Codex CLI 历史记录。" } }, { status: 503 });
  }
}
