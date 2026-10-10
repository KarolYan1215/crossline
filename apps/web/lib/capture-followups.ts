import "server-only";
import type { AccessContext } from "@crossline/core";
import { requestCodexSupervisor } from "./codex-runtime";

// Fire-and-forget, never awaited by the response: a capture is already fully written (its own row, its
// own event) by the time this runs, and a compaction failure must never look like the capture itself
// failed. Additive to this route handler, not to `addCapturedTaskWithId` itself — that function's own
// "captures a row, nothing else, zero classification" invariant stays true; this is a separate step.
export function extractBackgroundFactsInBackground(ctx: AccessContext, captureTitle: string, captureContext: string): void {
  requestCodexSupervisor(ctx, "/v1/background-facts/extract", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ captureTitle, captureContext }),
    signal: AbortSignal.timeout(60_000)
  }).catch(() => {});
}

// Also fire-and-forget: the worker classifies new captures on its own tick, but that is up to fifteen minutes away, and the person who
// just wrote something down is looking at it now. The worker applies the same rules as its tick (a line to file it under, quota
// not spent), so asking early changes when it happens, never whether it is allowed.
// A few seconds late on purpose: the form uploads attachments in a second request after this one, and the analysis names them.
const ATTACHMENT_GRACE_MS = 5_000;
export function analyzeNewCapturesInBackground(ctx: AccessContext): void {
  setTimeout(() => {
    requestCodexSupervisor(ctx, "/v1/captures/auto-analyze", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      signal: AbortSignal.timeout(10_000)
    }).catch(() => {});
  }, ATTACHMENT_GRACE_MS);
}
