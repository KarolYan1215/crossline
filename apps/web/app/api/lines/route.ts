import { resolveAccessContext } from "../../../lib/access-guard";
import { addLine, linePacks, rankLines, updateLine } from "../../../lib/lines";
import { isCrossSiteWrite } from "../../../lib/same-origin";
import { withUndo } from "../../../lib/undo";

/** The workspace's lines: id, name, colour, long-term goal, archived or not. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return Response.json({ ok: true, lines: linePacks(access.ctx, { includeArchived: true }).filter((pack) => pack.kind === "identity")
    .map((pack) => ({ id: pack.id, label: pack.label, color: pack.color ?? pack.id, goal: pack.goal ?? "", goals: pack.goals ?? [],
      hard: Boolean(pack.hard), rank: pack.rank ?? null })) });
}

/**
 * `{label, goals?, color?, hard?}` adds a line (its interview follows); `{id, label?, goals?, color?, archived?, hard?, rank?}` changes one;
 * `{order: [ids]}` sets the 12–24 month order (unlisted lines run in parallel). All undoable.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const text = (value: unknown) => typeof value === "string" ? value : undefined;
  const goals = Array.isArray(body.goals) ? (body.goals as unknown[]).filter((goal): goal is string => typeof goal === "string") : undefined;
  if (Array.isArray(body.order)) {
    const order = (body.order as unknown[]).filter((id): id is string => typeof id === "string");
    return Response.json(await withUndo(access.ctx, "调整主线主次", () => rankLines(access.ctx, order)));
  }
  if (typeof body.id === "string") {
    const change = { ...(text(body.label) !== undefined ? { label: text(body.label)! } : {}), ...(text(body.goal) !== undefined ? { goal: text(body.goal)! } : {}),
      ...(goals ? { goals } : {}), ...(typeof body.hard === "boolean" ? { hard: body.hard } : {}),
      ...(body.rank === null || typeof body.rank === "number" ? { rank: body.rank as number | null } : {}),
      ...(text(body.color) ? { color: text(body.color)! } : {}), ...(typeof body.archived === "boolean" ? { archived: body.archived } : {}) };
    const result = await withUndo(access.ctx, `修改主线：${text(body.label) ?? body.id}`, () => updateLine(access.ctx, body.id as string, change));
    return Response.json(result, { status: result.ok ? 200 : result.code === "LINE_NOT_FOUND" ? 404 : 400 });
  }
  const result = await withUndo(access.ctx, `新增主线：${text(body.label) ?? ""}`, () => addLine(access.ctx, { label: text(body.label) ?? "", goal: text(body.goal) ?? "", ...(goals ? { goals } : {}),
    ...(body.hard === true ? { hard: true } : {}), ...(text(body.color) ? { color: text(body.color)! } : {}) }));
  return Response.json(result, { status: result.ok ? 200 : 400 });
}
