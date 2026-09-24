import "server-only";
import { headers } from "next/headers";

/**
 * `tailscale serve` forwards exactly these three identity headers to a proxied backend on tailnet
 * traffic — verified against Tailscale's own docs before writing this, not assumed: no node identifier
 * is forwarded, which is why `tailscale_bindings.node_key` (packages/db) is nullable. Absent entirely
 * for a request that did not come through Serve (plain `http://127.0.0.1:3210`, or Funnel traffic, which
 * this app never enables) — that is the normal case for local use and is not an error.
 */
export type TailscaleIdentity = { login: string; name?: string };

export async function readTailscaleIdentity(): Promise<TailscaleIdentity | null> {
  const list = await headers();
  const login = list.get("tailscale-user-login");
  if (!login) return null;
  const name = list.get("tailscale-user-name");
  return { login, ...(name ? { name } : {}) };
}
