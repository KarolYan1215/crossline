import { resolveAccessContext } from "../../../lib/access-guard";
import { searchMentions, type Mention } from "../../../lib/input";

/** `?q=&kind=`: what `@` can reference — open tasks, live milestones, long-term goals, files; `kind=linkable` is all but files. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const params = new URL(request.url).searchParams;
  const kind = params.get("kind");
  return Response.json({ ok: true, results: searchMentions(access.ctx, (params.get("q") ?? "").slice(0, 100),
    kind === "material" || kind === "task" || kind === "milestone" || kind === "goal" || kind === "linkable" ? kind as Mention["kind"] | "linkable" : undefined) });
}
