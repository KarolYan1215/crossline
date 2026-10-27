import { cleanSourcesPayload } from "@crossline/core";
import { applyDeviceSources, handleDeviceSend } from "../../../../lib/device";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/**
 * Files a linked computer read from its authorized folders (docs/device-mode.md): their text, names and sha256, the folders' labels and
 * lines, and removals. `device` token only; kept once per file content.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  return handleDeviceSend(request, cleanSourcesPayload, applyDeviceSources);
}
