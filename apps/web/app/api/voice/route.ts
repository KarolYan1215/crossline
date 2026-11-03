import { resolveAccessContext } from "../../../lib/access-guard";
import { voiceStatus } from "../../../lib/voice";

/** What every page's microphone reads once (docs/voice-input.md): the person's voice settings and whether Crossline's own engine can take a clip. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return Response.json(await voiceStatus(access.ctx), { headers: { "cache-control": "no-store" } });
}
