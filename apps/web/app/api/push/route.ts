import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../lib/access-guard";
import { pushDevices, pushPublicKey } from "../../../lib/push";

/** The key a phone subscribes with, and the devices already subscribed. Read-only. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return NextResponse.json({ ok: true, publicKey: pushPublicKey(), devices: pushDevices(access.ctx) }, { headers: { "cache-control": "no-store" } });
}
