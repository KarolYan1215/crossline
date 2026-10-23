import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { primaryOrigin } from "@crossline/core";
import type { SecretStore } from "@crossline/connectors";

/**
 * This computer's link to the hosted account it is a device of (docs/device-mode.md). Two files, both outside the ledger: the site's
 * address in `<data>/device/link.json` (not secret; the web app reads it to know it is a device and where to send its pages), and the
 * `device` token as a DPAPI file through the worker's secret store (only this Windows user can open it; not in any backup).
 *
 * A file rather than environment variables: the person links and unlinks from the `/device` page, without editing a start script, and the
 * token never sits in a process environment.
 */
export const DEVICE_SECRET_SLOT = "machine";
export const DEVICE_SECRET_NAME = "device-token";
export const linkFile = (dataDir: string) => path.join(dataDir, "device", "link.json");

export type DeviceLinkRecord = { url: string; label: string; linkedAt: string };
export type DeviceLink = DeviceLinkRecord & { token: string | undefined };

/** The link as written, without the token: whether this install is a device at all (the web app asks the same file). */
export function readLinkRecord(dataDir: string): DeviceLinkRecord | undefined {
  try {
    const raw = JSON.parse(readFileSync(linkFile(dataDir), "utf8")) as Partial<DeviceLinkRecord>;
    const url = typeof raw.url === "string" ? primaryOrigin(raw.url) : undefined;
    return url ? { url, label: typeof raw.label === "string" ? raw.label : hostname(), linkedAt: typeof raw.linkedAt === "string" ? raw.linkedAt : "" } : undefined;
  } catch { return undefined; }
}

/** The link with its token; `token` is undefined when the secret cannot be read (then nothing is sent and the device page says why). */
export async function readDeviceLink(dataDir: string, secrets: SecretStore): Promise<DeviceLink | undefined> {
  const record = readLinkRecord(dataDir);
  if (!record) return undefined;
  const token = await secrets.read(DEVICE_SECRET_SLOT, DEVICE_SECRET_NAME).catch(() => undefined);
  return { ...record, token: token?.trim() || undefined };
}

export type LinkCheck = { ok: true } | { ok: false; code: string; message: string };

/** Asks the site whether this token is a `device` token of an account there, before anything is kept. */
export async function checkPrimary(url: string, token: string, fetchImpl: typeof fetch = fetch): Promise<LinkCheck> {
  const response = await fetchImpl(new URL("/api/device/hello", url), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) })
    .catch(() => undefined);
  if (!response) return { ok: false, code: "DEVICE_PRIMARY_UNREACHABLE", message: "连不上这个地址。" };
  if (response.status === 401) return { ok: false, code: "DEVICE_TOKEN_INVALID", message: "令牌无效或已撤销：在网页版「这台电脑」重新生成一个。" };
  if (!response.ok) return { ok: false, code: `DEVICE_PRIMARY_HTTP_${response.status}`, message: `网页版回答 ${response.status}，没有连上。` };
  return { ok: true };
}

export async function saveDeviceLink(dataDir: string, secrets: SecretStore, input: { url: string; token: string; label?: string }, now = new Date()): Promise<DeviceLinkRecord> {
  const record = { url: input.url, label: (input.label ?? hostname()).slice(0, 60), linkedAt: now.toISOString() };
  await secrets.write(DEVICE_SECRET_SLOT, DEVICE_SECRET_NAME, input.token);
  mkdirSync(path.dirname(linkFile(dataDir)), { recursive: true });
  writeFileSync(linkFile(dataDir), JSON.stringify(record, null, 2));
  return record;
}

export function clearDeviceLink(dataDir: string, secrets: SecretStore): void {
  rmSync(linkFile(dataDir), { force: true });
  rmSync(nodeFile(dataDir), { force: true });
  secrets.remove(DEVICE_SECRET_SLOT, DEVICE_SECRET_NAME);
}

/**
 * 「作为算力节点」 on this computer (docs/compute-node.md): off unless the person switched it on here, and the hosted site accepts the node
 * only when it is switched on there too. A file beside the link, for the same reason the link is one.
 */
export const nodeFile = (dataDir: string) => path.join(dataDir, "device", "node.json");
export function nodeEnabled(dataDir: string): boolean {
  try { return (JSON.parse(readFileSync(nodeFile(dataDir), "utf8")) as { enabled?: unknown }).enabled === true; } catch { return false; }
}
export function setNodeEnabled(dataDir: string, enabled: boolean, now = new Date()): void {
  if (!enabled) { rmSync(nodeFile(dataDir), { force: true }); return; }
  mkdirSync(path.dirname(nodeFile(dataDir)), { recursive: true });
  writeFileSync(nodeFile(dataDir), JSON.stringify({ enabled: true, at: now.toISOString() }, null, 2));
}

/**
 * `/v1/device/link` on the worker's loopback port, in both modes: GET the link and what waits to be sent, POST `{url, token}` (checked
 * against the site, then kept), DELETE to unlink. Linking or unlinking calls `onChanged`, which restarts the worker into the other mode.
 */
export function createDeviceLinkService(deps: { dataDir: string; secrets: SecretStore; fetch?: typeof fetch; status?: () => unknown; nodeStatus?: () => unknown;
  onChanged: () => void }) {
  return {
    async handle(method: string, pathname: string, _workspaceId: string, body: Record<string, unknown> | undefined): Promise<{ status: number; body: unknown } | undefined> {
      // The compute node switch: kept, then the worker restarts so the device starts or stops offering its runtime.
      if (pathname === "/v1/device/node") {
        if (method !== "POST") return { status: 405, body: { ok: false, code: "METHOD_NOT_ALLOWED" } };
        if (!readLinkRecord(deps.dataDir)) return { status: 400, body: { ok: false, code: "DEVICE_NOT_LINKED", message: "先连接网页版，再开启算力节点。" } };
        const enabled = body?.enabled === true;
        if (enabled !== nodeEnabled(deps.dataDir)) { setNodeEnabled(deps.dataDir, enabled); deps.onChanged(); }
        return { status: 200, body: { ok: true, enabled } };
      }
      if (pathname !== "/v1/device/link") return undefined;
      if (method === "GET") {
        const link = await readDeviceLink(deps.dataDir, deps.secrets);
        return { status: 200, body: { ok: true, linked: Boolean(link), ...(link ? { url: link.url, label: link.label, linkedAt: link.linkedAt, tokenReadable: Boolean(link.token) } : {}),
          ...(deps.status ? { device: deps.status() } : {}),
          node: { enabled: nodeEnabled(deps.dataDir), ...(deps.nodeStatus ? { status: deps.nodeStatus() } : {}) } } };
      }
      if (method === "POST") {
        const url = typeof body?.url === "string" ? primaryOrigin(body.url) : undefined;
        const token = typeof body?.token === "string" ? body.token.trim() : "";
        if (!url) return { status: 400, body: { ok: false, code: "DEVICE_URL_INVALID", message: "地址要以 https:// 开头，例如 https://app.crossline.lol。" } };
        if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return { status: 400, body: { ok: false, code: "DEVICE_TOKEN_INVALID", message: "令牌格式不对：复制网页版显示的整串字符。" } };
        const checked = await checkPrimary(url, token, deps.fetch);
        if (!checked.ok) return { status: 400, body: checked };
        const record = await saveDeviceLink(deps.dataDir, deps.secrets, { url, token });
        deps.onChanged();
        return { status: 200, body: { ok: true, linked: true, ...record, restarting: true } };
      }
      if (method === "DELETE") {
        const was = readLinkRecord(deps.dataDir);
        clearDeviceLink(deps.dataDir, deps.secrets);
        if (was) deps.onChanged();
        return { status: 200, body: { ok: true, linked: false, restarting: Boolean(was) } };
      }
      return { status: 405, body: { ok: false, code: "METHOD_NOT_ALLOWED" } };
    }
  };
}
