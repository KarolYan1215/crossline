import { resolveAccessContext } from "../../../lib/access-guard";
import { addLine, linePacks, updateLine } from "../../../lib/lines";
import { isCrossSiteWrite } from "../../../lib/same-origin";
import { withUndo } from "../../../lib/undo";

/** The workspace's lines: id, name, colour, long-term goal, archived or not. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return Response.json({ ok: true, lines: linePacks(access.ctx, { includeArchived: true }).filter((pack) => pack.kind === "identity")
    .map((pack) => ({ id: pack.id, label: pack.label, color: pack.color ?? pack.id, goal: pack.goal ?? "" })) });
}

/**
 * `{label, goal, color?}` adds a line (its interview follows); `{id, label?, goal?, color?, archived?}` changes one. Both undoable.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const text = (value: unknown) => typeof value === "string" ? value : undefined;
  if (typeof body.id === "string") {
    const change = { ...(text(body.label) !== undefined ? { label: text(body.label)! } : {}), ...(text(body.goal) !== undefined ? { goal: text(body.goal)! } : {}),
      ...(text(body.color) ? { color: text(body.color)! } : {}), ...(typeof body.archived === "boolean" ? { archived: body.archived } : {}) };
    const result = await withUndo(access.ctx, `修改主线：${text(body.label) ?? body.id}`, () => updateLine(access.ctx, body.id as string, change));
    return Response.json(result, { status: result.ok ? 200 : 404 });
  }
  const result = await withUndo(access.ctx, `新增主线：${text(body.label) ?? ""}`, () => addLine(access.ctx, { label: text(body.label) ?? "", goal: text(body.goal) ?? "", ...(text(body.color) ? { color: text(body.color)! } : {}) }));
  return Response.json(result, { status: result.ok ? 200 : 400 });
}
