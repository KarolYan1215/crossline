import { deviceAccess } from "../../../../lib/device";

/** A linked computer checking its token before it keeps it (docs/device-mode.md): ok, or 401. */
export async function GET(request: Request) {
  const access = deviceAccess(request, { needsKey: false });
  if ("response" in access) return access.response;
  return Response.json({ ok: true });
}
