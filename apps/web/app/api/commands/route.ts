import { validateCommandEnvelope } from "@crossline/core";
import {
  addCapturedTaskWithId,
  WORKSPACE_ID
} from "../../../lib/crossline";

export async function POST(request: Request) {
  const validation = validateCommandEnvelope(await request.json().catch(() => null));
  if (!validation.ok) return Response.json(validation.blocker, { status: 400 });
  const command = validation.command;
  if (command.ownerId !== "local-owner" || command.workspaceId !== WORKSPACE_ID) {
    return Response.json({ code: "COMMAND_SCOPE_MISMATCH" }, { status: 403 });
  }
  const payload = command.payload as Record<string, unknown>;
  if (command.type === "task.capture") {
    const title = String(payload.title ?? "").trim();
    const context = String(payload.context ?? "").trim();
    if (!title || title.length > 240 || context.length > 500) {
      return Response.json({ code: "INVALID_TASK_INPUT" }, { status: 400 });
    }
    addCapturedTaskWithId({ title, context }, command.clientCommandId, command.clientCommandId);
  } else {
    return Response.json({ code: "COMMAND_TYPE_NOT_ALLOWED" }, { status: 400 });
  }
  return Response.json({ accepted: true, clientCommandId: command.clientCommandId });
}
