import { resolveAccessContext } from "../../../lib/access-guard";
import { outputFolder } from "../../../lib/outputs";

/** The assistant's output folder: what every finished run handed over, by line and by task. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return Response.json(outputFolder(access.ctx), { headers: { "cache-control": "no-store" } });
}
