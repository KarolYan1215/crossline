import { NextResponse } from "next/server";
import { addAiTool, removeAiTool } from "@crossline/db";
import { getStore } from "../../../lib/crossline";
import { writeGuard, validId } from "../agent/guard";

/**
 * The AI tools the person works with (docs/skills-library.md §7). `POST {name, kind, goodFor}` names one; `DELETE {id}` removes one the
 * person named (the built-in and detected ones are not theirs to remove here). Plans made after this assume the new list.
 */
export async function POST(request: Request) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { name, kind, goodFor } = guard.body;
  if (typeof name !== "string" || typeof goodFor !== "string" || (kind !== undefined && typeof kind !== "string")) {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  }
  const tool = addAiTool(getStore(), guard.ctx.workspaceId, { name, kind: kind ?? "other", goodFor });
  return tool ? NextResponse.json({ ok: true, tool }) : NextResponse.json({ ok: false, code: "TOOL_NAME_EMPTY" }, { status: 400 });
}

export async function DELETE(request: Request) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const id = guard.body.id;
  if (typeof id !== "string" || !validId(id.replace(/[^\x00-\x7f]/g, "x"))) return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  return removeAiTool(getStore(), guard.ctx.workspaceId, id) ? NextResponse.json({ ok: true }) : NextResponse.json({ ok: false, code: "TOOL_NOT_FOUND" }, { status: 404 });
}
