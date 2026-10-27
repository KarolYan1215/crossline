import { cleanRecordingsPayload } from "@crossline/core";
import { applyDeviceRecordings, handleDeviceSend } from "../../../../lib/device";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/**
 * Transcripts a linked computer made of its own recordings, and those it found silent (docs/device-mode.md). The audio never comes here.
 * `device` token only; one per recording, by the audio's sha256.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  return handleDeviceSend(request, cleanRecordingsPayload, applyDeviceRecordings);
}
