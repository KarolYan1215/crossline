import { cleanCommitsPayload } from "@crossline/core";
import { applyDeviceCommits, handleDeviceSend } from "../../../../lib/device";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/**
 * Commits a linked computer read from the git repositories the person authorized there (docs/plans/execution-gates-1124.md J1): id,
 * author time, subject, changed file names — masked on the device, never a diff. `device` token only; one `git.commit_seen` event per
 * repository and commit, so neither a repeated idempotency key nor a resend adds a second.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  return handleDeviceSend(request, cleanCommitsPayload, applyDeviceCommits);
}
