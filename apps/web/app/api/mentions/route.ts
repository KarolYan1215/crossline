import { resolveAccessContext } from "../../../lib/access-guard";
import { searchMentions, type Mention } from "../../../lib/input";

/** `?q=&kind=`: what `@` can reference — files, open tasks, live milestones. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const params = new URL(request.url).searchParams;
  const kind = params.get("kind");
  return Response.json({ ok: true, results: searchMentions(access.ctx, params.get("q") ?? "",
    kind === "material" || kind === "task" || kind === "milestone" || kind === "goal" ? kind as Mention["kind"] : undefined) });
}
