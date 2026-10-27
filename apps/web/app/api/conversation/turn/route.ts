import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { conversationTurn, type Mention } from "../../../../lib/conversation";

const KINDS = new Set(["material", "task", "milestone", "goal"]);

/** `{text, mentions, page, files}`: one turn of the one input box (`files`: ids from `/api/conversation/files`). The person's words are kept before anything else happens. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = (await request.json().catch(() => ({}))) as { text?: unknown; mentions?: unknown; page?: unknown; files?: unknown };
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 4000) : "";
  const files = Array.isArray(body.files) ? body.files.filter((id): id is string => typeof id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(id)).slice(0, 6) : [];
  if (!text && !files.length) return Response.json({ ok: false, code: "INPUT_EMPTY" }, { status: 400 });
  const mentions: Mention[] = Array.isArray(body.mentions) ? (body.mentions as Array<Record<string, unknown>>)
    .filter((item) => KINDS.has(String(item.kind)) && typeof item.id === "string" && /^[a-zA-Z0-9_:-]{1,128}$/.test(item.id))
    .map((item) => ({ kind: item.kind as Mention["kind"], id: String(item.id), title: String(item.title ?? "").slice(0, 200) })).slice(0, 20) : [];
  const raw = (body.page && typeof body.page === "object" ? body.page : {}) as { kind?: unknown; entityId?: unknown; stepId?: unknown };
  const page = { kind: typeof raw.kind === "string" ? raw.kind.slice(0, 32) : "", entityId: typeof raw.entityId === "string" ? raw.entityId.slice(0, 128) : "",
    ...(typeof raw.stepId === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(raw.stepId) ? { stepId: raw.stepId } : {}) };
  return Response.json({ ok: true, messages: await conversationTurn(access.ctx, { text, mentions, page, files }) });
}
