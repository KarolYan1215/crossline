import { NextResponse } from "next/server";
import { CodexSupervisorRequestError, requestCodexSupervisor } from "../../../../lib/codex-runtime";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { resolveAccessContext } from "../../../../lib/access-guard";

export const runtime = "nodejs";

/**
 * This account's own third-party model connection (R7; Settings → 模型连接). The worker keeps it: the address and model as a setting,
 * the key in an encrypted file. A key passes through here once, on the way to the worker, and is never stored or sent back.
 */
const failure = (error: unknown) => {
  const known = error instanceof CodexSupervisorRequestError ? error
    : new CodexSupervisorRequestError(503, { code: "CODEX_SUPERVISOR_UNAVAILABLE", message: "后台服务没有连上，稍后再试。" });
  return NextResponse.json({ blocker: known.blocker }, { status: known.status });
};

export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  try { return NextResponse.json(await requestCodexSupervisor(access.ctx, "/v1/model/provider")); }
  catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const pick = (key: string) => typeof body[key] === "string" ? (body[key] as string).slice(0, 500) : undefined;
  const forward = Object.fromEntries(["id", "kind", "label", "baseUrl", "model", "apiKey", "responseFormat"]
    .map((key) => [key, pick(key)]).filter(([, value]) => value !== undefined));
  try {
    return NextResponse.json(await requestCodexSupervisor(access.ctx, "/v1/model/provider", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(forward) }));
  } catch (error) { return failure(error); }
}

export async function DELETE(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  try { return NextResponse.json(await requestCodexSupervisor(access.ctx, "/v1/model/provider", { method: "DELETE" })); }
  catch (error) { return failure(error); }
}
