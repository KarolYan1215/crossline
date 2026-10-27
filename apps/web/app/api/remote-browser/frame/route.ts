import { resolveAccessContext } from "../../../../lib/access-guard";
import { serviceProxy } from "../../../../lib/service-proxy";

/**
 * The login dialog's picture of the server browser (docs/skills-library.md 「托管版登录」): the latest frame when it is newer than
 * `after`, where the browser is, or `{open: false}` once it has closed. Polled a few times a second while the dialog is open.
 */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const after = Math.max(0, Math.min(999_999_999, Math.floor(Number(new URL(request.url).searchParams.get("after")) || 0)));
  return serviceProxy(access.ctx, `/v1/remote-browser/frame/${after}`, { timeoutMs: 10_000 });
}
