import { assistantAvailable as machineOwner } from "@crossline/db";
import { NextResponse } from "next/server";
import { dataDirectory, getStore } from "../../../../lib/crossline";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { setRecordingConsent } from "../../../../lib/recordings";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/**
 * 录音自动转写 (docs/phone-recording.md): whether recordings in the authorized folders are transcribed on this machine. Off takes `keep`:
 * true keeps the transcripts already made, false deletes them.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { on?: unknown; keep?: unknown } | null;
  // The recordings are files on this computer, so only its owner's account may have them read (as for folders and screen activity).
  if (body?.on === true && !machineOwner(getStore(), access.ctx.workspaceId)) return NextResponse.json({ ok: false, code: "MACHINE_OWNER_ONLY" }, { status: 403 });
  if (typeof body?.on !== "boolean" || (body.on === false && typeof body.keep !== "boolean")) return NextResponse.json({ ok: false, code: "INVALID_RECORDING_CONSENT" }, { status: 400 });
  const { deleted } = setRecordingConsent(getStore(), access.ctx.workspaceId, body.on,
    { keep: body.keep !== false, dataDir: dataDirectory(), ownerId: access.ctx.principalId });
  return NextResponse.json({ ok: true, deleted });
}
