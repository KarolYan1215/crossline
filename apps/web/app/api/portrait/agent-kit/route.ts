import { resolveAccessContext } from "../../../../lib/access-guard";
import { agentKitMarkdown, buildAgentKit } from "../../../../lib/agent-kit";
import { tOf } from "../../../../lib/locale";
import { loadAgentKitInput } from "../../../../lib/portrait";

/** The portrait for an outside AI agent: a Markdown file to download, or `?format=json` with the same content structured. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const t = tOf(access.ctx);
  const kit = buildAgentKit(loadAgentKitInput(access.ctx), t);
  if (new URL(request.url).searchParams.get("format") === "json") return Response.json({ ok: true, kit }, { headers: { "cache-control": "no-store" } });
  const name = t("crossline-画像-{{date}}.md", { date: kit.generatedAt });
  return new Response(agentKitMarkdown(kit, t), { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store",
    "content-disposition": `attachment; filename="crossline-profile.md"; filename*=UTF-8''${encodeURIComponent(name)}` } });
}
