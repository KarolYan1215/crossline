import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../../../lib/access-guard";
import { setServerRecordings } from "../../../../../lib/consents";
import { isCrossSiteWrite } from "../../../../../lib/same-origin";

/**
 * 录音在服务器转写 (docs/phone-recording.md 「服务器转写」): whether the phone's shortcut may upload recordings for the server to
 * transcribe at night. Its own consent, apart from 录音自动转写 on the person's computer, because the audio leaves their devices. Off takes
 * `keep` (whether the transcripts made stay) and always deletes the recordings still waiting.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { on?: unknown; keep?: unknown } | null;
  if (typeof body?.on !== "boolean" || (body.on === false && typeof body.keep !== "boolean")) return NextResponse.json({ ok: false, code: "INVALID_RECORDING_CONSENT" }, { status: 400 });
  const result = setServerRecordings(access.ctx, body.on, body.keep !== false);
  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}
