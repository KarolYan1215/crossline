import { TYPE_TABLE } from "@crossline/core/assess";
import { appUrl } from "./config";
import type { StoredResult } from "./store";

/**
 * 「申请内测」 passed on to the Crossline app (2026-11-06), so the developer gets the same mail as for an application made in the app —
 * the address, the type, and the link that approves it and mails back a code — instead of only a row in `beta_requests` that someone
 * has to remember to list. Server to server: `POST <ASSESS_APP_URL>/api/invites/request` with `Authorization: Bearer
 * <ASSESS_LINK_SECRET>` (the secret both sides already share for /api/link). Off unless both are set. Never fails the request: the row
 * is kept either way, and an unreachable app is logged with the result's id, never the address.
 */
export async function forwardBetaRequest(result: StoredResult, fetcher: typeof fetch = fetch): Promise<boolean> {
  const app = appUrl(), secret = process.env.ASSESS_LINK_SECRET?.trim();
  if (!app || !secret) return false;
  const type = TYPE_TABLE[result.code];
  try {
    const response = await fetcher(`${app}/api/invites/request`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      /* i18n-ignore-start: read by the developer in the approval mail */
      body: JSON.stringify({ email: result.email, source: "assess", detail: `速测类型 ${type?.name ?? ""} ${result.code}`.trim(),
        reason: "在公开测评的结果页申请内测" }),
      /* i18n-ignore-end */
      signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) console.warn(JSON.stringify({ event: "assess.beta_forward_failed", resultId: result.id, status: response.status }));
    return response.ok;
  } catch (error) {
    console.warn(JSON.stringify({ event: "assess.beta_forward_failed", resultId: result.id, error: error instanceof Error ? error.message : String(error) }));
    return false;
  }
}
