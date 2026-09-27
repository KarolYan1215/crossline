import { NextResponse } from "next/server";
import { requestCodexSupervisor, CodexSupervisorRequestError } from "../../../../lib/codex-runtime";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, blocker: { code: "REQUEST_FORBIDDEN", message: "Use the local Web API" } }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  let body: unknown = {};
  try { body = await request.json(); } catch { /* validated below */ }
  const input = (body ?? {}) as { answers?: unknown; sources?: unknown };
  const answers = Array.isArray(input.answers) ? input.answers
    .filter((item): item is { question: unknown; answer: unknown } => typeof item === "object" && item !== null)
    .map((item) => ({ question: String((item as { question?: unknown }).question ?? "").slice(0, 500),
      answer: String((item as { answer?: unknown }).answer ?? "").slice(0, 2000) })) : [];
  // Opt-in local context (today: summarised Codex CLI session history) the person already consented to
  // sharing — see `codex-history-consent.tsx`. Absent means they never consented, not an empty read.
  const sources = Array.isArray(input.sources) ? input.sources
    .filter((item): item is { label: unknown; excerpt: unknown } => typeof item === "object" && item !== null)
    .map((item) => ({ label: String((item as { label?: unknown }).label ?? "").slice(0, 200),
      excerpt: String((item as { excerpt?: unknown }).excerpt ?? "").slice(0, 4000) })) : [];
  try {
    const result = await requestCodexSupervisor<unknown>(access.ctx, "/v1/onboarding/propose", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answers, sources }),
      signal: AbortSignal.timeout(10 * 60_000)
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof CodexSupervisorRequestError) {
      return NextResponse.json({ ok: false, blocker: error.blocker }, { status: error.status });
    }
    return NextResponse.json({ ok: false, blocker: { code: "ONBOARDING_FAILED", message: "入职提议未完成。" } }, { status: 503 });
  }
}
