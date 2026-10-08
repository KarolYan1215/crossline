import { resolveAccessContext } from "../../../../lib/access-guard";
import { createMilestoneDraft } from "../../../../lib/input";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { withUndo } from "../../../../lib/undo";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `{lineId, title, date?, target?}`: a milestone the person wrote, saved as a draft on its line and approved like any other. Undoable. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";
  const title = text(body.title, 200);
  const date = text(body.date, 10);
  if (!title) return Response.json({ ok: false, code: "MILESTONE_TITLE_REQUIRED" }, { status: 400 });
  if (date && !DAY.test(date)) return Response.json({ ok: false, code: "MILESTONE_DATE_INVALID" }, { status: 400 });
  const result = await withUndo(access.ctx, `新建里程碑草稿：${title}`, () => createMilestoneDraft(access.ctx, { lineId: text(body.lineId, 80), title, date, target: text(body.target, 500) }));
  return Response.json(result, { status: result.ok ? 200 : 400 });
}
