import { validateCommandEnvelope } from "@crossline/core";
import { addCapturedTaskWithId } from "../../../lib/crossline";
import { resolveAccessContext } from "../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../lib/same-origin";

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const { ctx } = access;
  const validation = validateCommandEnvelope(await request.json().catch(() => null));
  if (!validation.ok) return Response.json(validation.blocker, { status: 400 });
  const command = validation.command;
  // The envelope's ownerId/workspaceId is the client's own claim, replayed from its offline outbox —
  // it proves nothing by itself. The session `ctx` above is the actual authority; this check only
  // catches a stale queue replaying commands recorded under a different account than the one now signed in.
  if (command.ownerId !== ctx.principalId || command.workspaceId !== ctx.workspaceId) {
    return Response.json({ code: "COMMAND_SCOPE_MISMATCH" }, { status: 403 });
  }
  const payload = command.payload as Record<string, unknown>;
  if (command.type === "task.capture") {
    const title = String(payload.title ?? "").trim();
    const context = String(payload.context ?? "").trim();
    if (!title || title.length > 240 || context.length > 500) {
      return Response.json({ code: "INVALID_TASK_INPUT" }, { status: 400 });
    }
    addCapturedTaskWithId(ctx, { title, context }, command.clientCommandId, command.clientCommandId);
  } else {
    return Response.json({ code: "COMMAND_TYPE_NOT_ALLOWED" }, { status: 400 });
  }
  return Response.json({ accepted: true, clientCommandId: command.clientCommandId });
}
