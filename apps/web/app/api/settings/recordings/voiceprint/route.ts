import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../../../lib/access-guard";
import { setVoiceprint } from "../../../../../lib/consents";
import { isCrossSiteWrite } from "../../../../../lib/same-origin";

/**
 * 识别本人声音 (docs/phone-recording.md 「说话人」): whether the server transcriber may keep the person's voiceprint and mark their lines
 * 「本人」. Its own consent, off by default, because a voiceprint is biometric. Off deletes the voiceprint and any recording waiting to
 * become one.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { on?: unknown } | null;
  if (typeof body?.on !== "boolean") return NextResponse.json({ ok: false, code: "INVALID_VOICEPRINT_CONSENT" }, { status: 400 });
  const result = setVoiceprint(access.ctx, body.on);
  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}
