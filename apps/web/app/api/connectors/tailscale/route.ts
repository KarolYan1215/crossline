import { randomUUID } from "node:crypto";
import { tOf } from "../../../../lib/locale";
import { getStore } from "../../../../lib/crossline";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/**
 * Records that the owner, while already signed in through a normal session, confirmed a specific
 * Tailscale login as really them (`packages/db`'s `saveTailscaleBinding`). This is an audit fact, not an
 * authentication path — nothing here bypasses or shortcuts Better Auth's own session check on any other
 * route, by design (see `docs/codex-fork-runtime.md`-style "暂不支持" framing in the stage-six plan: an
 * automatic Tailscale-header passthrough login was explicitly decided against).
 */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const bindings = getStore().listTailscaleBindings(access.ctx.workspaceId);
  const login = request.headers.get("tailscale-user-login");
  const name = request.headers.get("tailscale-user-name");
  return Response.json({
    ok: true, bindings,
    // What this exact request arrived carrying — absent for anything not proxied by `tailscale serve`.
    current: login ? { login, ...(name ? { name } : {}) } : null
  });
}

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const login = request.headers.get("tailscale-user-login");
  if (!login) {
    return Response.json({ ok: false, code: "TAILSCALE_IDENTITY_NOT_PRESENT",
      message: tOf(access.ctx)("本次请求没有携带 Tailscale 身份头，请通过 tailscale serve 访问后再试") }, { status: 400 });
  }
  const binding = getStore().saveTailscaleBinding({
    id: randomUUID(), principalId: access.ctx.principalId, workspaceId: access.ctx.workspaceId,
    tailscaleLogin: login, createdAt: new Date().toISOString()
  });
  return Response.json({ ok: true, binding });
}

export async function DELETE(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = (await request.json().catch(() => ({}))) as { tailscaleLogin?: unknown };
  const tailscaleLogin = typeof body.tailscaleLogin === "string" ? body.tailscaleLogin : "";
  if (!tailscaleLogin) return Response.json({ ok: false, code: "TAILSCALE_LOGIN_REQUIRED" }, { status: 400 });
  const result = getStore().revokeTailscaleBinding(access.ctx.workspaceId, tailscaleLogin);
  return Response.json({ ok: true, changed: result.changed });
}
