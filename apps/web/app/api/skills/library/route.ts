import { resolveAccessContext } from "../../../../lib/access-guard";
import { loadSkillLibrary } from "../../../../lib/skill-library";

export const dynamic = "force-dynamic";

/** 设置 → Skill 库, read by the module once the settings page is shown (`SkillLibraryLoader`) rather than sent with the page. Read-only. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return Response.json({ ok: true, library: loadSkillLibrary(access.ctx) }, { headers: { "cache-control": "no-store" } });
}
